const express = require('express');
const AWS = require('aws-sdk');
const mysql = require('mysql2/promise');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const cors = require('cors');
require('dotenv').config();
const sharp = require('sharp');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// Database setup
const db = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'imageupload',
});

// AWS S3 configuration
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
});

// Multer setup (not used for URL uploads, but can be added for file uploads)
const upload = multer();

// Route to handle image upload from URL
app.post('/upload', async (req, res) => {
    const { imageUrl } = req.body; // Accept `imageUrl` in the request body

    if (!imageUrl) {
        return res.status(400).json({ error: 'Image URL is required' });
    }

    try {
        // Fetch image data from the URL
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data, 'binary');

        // Use sharp to extract image metadata (width, height, format)
        const image = sharp(buffer);
        const metadata = await image.metadata();
        const imageSize = (buffer.length / 1024).toFixed(2) + " KB"; // Size in KB
        const { width, height, format } = metadata; // Image width, height, format
        const imageFormat = format;

        // Generate a unique file name
        const fileName = `${Date.now()}-snowebs-${Math.random().toString(36).substring(7)}.jpg`;

        // Upload image to S3
        const uploadParams = {
            Bucket: process.env.AWS_S3_BUCKET,
            Key: fileName,
            Body: buffer,
            ContentType: response.headers['content-type'],
        };
        const s3Result = await s3.upload(uploadParams).promise();

        // Save public URL and image metadata to MySQL
        const publicUrl = s3Result.Location;
        const query = 'INSERT INTO fileupload (imageurl, size, width, height, format) VALUES (?, ?, ?, ?, ?)';
        await db.execute(query, [publicUrl, imageSize, width, height, imageFormat]);

        return res.status(200).json({
            message: 'Image uploaded successfully',
            url: publicUrl,
            size: imageSize,
            width: width,
            height: height,
            format: imageFormat
        });
    } catch (error) {
        console.error('Error uploading image:', error);
        return res.status(500).json({ error: 'Failed to upload image' });
    }
});






app.get('/generatepdf', async (req, res) => {
    try {
        const [rows] = await db.execute('SELECT * FROM fileupload');
        if (rows.length === 0) {
            return res.status(404).json({ error: 'No data found to generate PDF' });
        }

        // Create a new PDF document
        const doc = new PDFDocument();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="image-upload-report.pdf"');
        doc.pipe(res); // Stream the PDF directly to the response

        // Add title to the PDF
        doc.fontSize(18).text('Image Upload Report', { align: 'center' });
        doc.moveDown();

        // Add table headers
        const headerYPosition = 100;
        doc.fontSize(12)
            .text('Image', 50, headerYPosition)
            .text('Size (KB)', 200, headerYPosition)
            .text('Width', 300, headerYPosition)
            .text('Height', 400, headerYPosition)
            .text('Format', 500, headerYPosition);

        let yPosition = headerYPosition + 20; // Start position for rows
        const maxYPosition = 700;  // Maximum Y position before we need a new page

        // Loop through the rows and add them to the PDF
        for (const row of rows) {
            // Check if the next row exceeds the page's max Y position, if so, add a new page
            if (yPosition > maxYPosition) {
                doc.addPage(); // Start a new page
                yPosition = 100; // Reset Y position for new page
                doc.fontSize(12)
                    .text('Image', 50, yPosition)
                    .text('Size (KB)', 200, yPosition)
                    .text('Width', 300, yPosition)
                    .text('Height', 400, yPosition)
                    .text('Format', 500, yPosition);
                yPosition += 20;
            }

            try {
                const imageResponse = await axios.get(row.imageurl, { responseType: 'arraybuffer' });
                const imageBuffer = Buffer.from(imageResponse.data);

                // Add image to the PDF (adjust positioning as needed)
                const imageWidth = 100;
                const imageHeight = 100;
                doc.image(imageBuffer, 50, yPosition, { width: imageWidth, height: imageHeight }); // Resize the image to fit in the table

                // Add other image details
                doc.text(row.size, 200, yPosition);
                doc.text(row.width, 300, yPosition);
                doc.text(row.height, 400, yPosition);
                doc.text(row.format, 500, yPosition);

                // Move down for next row
                yPosition += imageHeight + 20; // Adjust for the image and text

            } catch (imageError) {
                console.error(`Error fetching image for URL ${row.imageurl}:`, imageError);
                // Optionally, add a placeholder for images that fail to load
                doc.text('Error loading image', 50, yPosition);
                yPosition += 20;
            }
        }

        doc.end(); // End the PDF document
    } catch (error) {
        console.error('Error generating PDF:', error);
        return res.status(500).json({ error: 'Failed to generate PDF' });
    }
});



// find metadata about files


async function getFileMetadata(bucketName, fileKey) {
    const params = {
        Bucket: bucketName,  // The S3 bucket name
        Key: fileKey,        // The S3 file key (path)
    };

    try {
        const data = await s3.headObject(params).promise();
        return {
            fileSize: data.ContentLength,       // File size in bytes
            uploadDate: data.LastModified,       // Date the file was uploaded
            contentType: data.ContentType,       // MIME type of the file
        };
    } catch (error) {
        console.error('Error fetching file metadata:', error);
        throw error;
    }
}

// Route to handle getting file metadata
app.post('/getfiledetails', async (req, res) => {
    const { fileKey } = req.body;  // Get the file key from the request body

    if (!fileKey) {
        return res.status(400).json({ error: 'File key is required' });
    }

    try {
        // Extract the file key from the URL (strip the base URL)
        const fileKeyWithoutBaseUrl = fileKey.split('amazonaws.com/')[1];

        // Log the file key to make sure it's correct
        console.log("Extracted File Key: ", fileKeyWithoutBaseUrl);

        // Call the getFileMetadata function
        const metadata = await getFileMetadata(process.env.AWS_S3_BUCKET, fileKeyWithoutBaseUrl);

        // Log the metadata to see what is returned
        console.log("File Metadata: ", metadata);
        const istDate = convertToIST(metadata.uploadDate);
        
        return res.status(200).json({
            message: 'File metadata retrieved successfully',
            fileSize: metadata.fileSize,
            contentType:metadata.contentType,
            istDate:istDate
        });
    } catch (error) {
        console.error('Error fetching file metadata:', error);
        return res.status(500).json({
            error: 'Failed to fetch file metadata',
            details: error.message,  // Include the error message for debugging
        });
    }
});

function convertToIST(utcDate) {
    const date = new Date(utcDate);  // Create a Date object from UTC string
    const utcOffset = 5.5 * 60 * 60 * 1000;  // IST is UTC +5:30 hours (in milliseconds)
    const istDate = new Date(date.getTime() + utcOffset);  // Convert to IST

    return istDate.toISOString();  // Return as ISO string in IST
}






// Start the server
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});


