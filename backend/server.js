require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fsSync.existsSync(uploadsDir)) {
    fsSync.mkdirSync(uploadsDir, { recursive: true });
    console.log('✅ Created uploads directory');
}

// Middleware — CORS restricted to production frontend + localhost dev
const allowedOrigins = [
    'https://celebrated-heliotrope-1bcaaf.netlify.app',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
];
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (curl, server-to-server, mobile apps)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
    }
}));
app.use(express.json());

// Configure multer for file uploads with proper file naming
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/')
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 100 * 1024 * 1024, // 100MB max
    }
});

// Serve uploaded files
app.use('/uploads', express.static('uploads'));

// Kling AI Configuration
const KLING_API_BASE = process.env.KLING_API_BASE_URL || 'https://api.klingai.com';
const KLING_ACCESS_KEY = process.env.KLING_ACCESS_KEY;
const KLING_SECRET_KEY = process.env.KLING_SECRET_KEY;

// S3 Configuration
const S3_ENABLED = process.env.S3_ENABLED === 'true';
const s3Client = S3_ENABLED ? new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: 'us-east-1', // Required but not used for custom endpoints
    credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY,
        secretAccessKey: process.env.S3_SECRET_KEY
    },
    forcePathStyle: true // Required for custom S3 endpoints
}) : null;

/**
 * Generate JWT token for Kling AI API authentication
 * Matching the exact implementation from official KlingDemo repository
 * Source: https://github.com/betasecond/KlingDemo/blob/master/src/klingdemo/api/client.py
 */
function generateJwtToken() {
    const currentTime = Math.floor(Date.now() / 1000);

    // Exact payload structure from official example
    const payload = {
        iss: KLING_ACCESS_KEY.trim(),     // Issuer: AccessKey
        exp: currentTime + 1800,           // Expiration: 30 minutes from now
        nbf: currentTime - 5               // Not before: 5 seconds ago (clock skew)
    };

    console.log('JWT Payload:', {
        iss: `${KLING_ACCESS_KEY.trim().substring(0, 10)}...`,
        exp: payload.exp,
        nbf: payload.nbf,
        current_time: currentTime
    });

    // Generate JWT with explicit headers (matching Python implementation)
    const token = jwt.sign(
        payload,
        KLING_SECRET_KEY.trim(),
        {
            algorithm: 'HS256',
            header: {
                alg: 'HS256',
                typ: 'JWT'
            }
        }
    );

    console.log('Generated JWT Token (first 50 chars):', token.substring(0, 50) + '...');
    console.log('Secret Key Length:', KLING_SECRET_KEY.trim().length);

    return token;
}

/**
 * Get authorization header for Kling AI API
 */
function getAuthHeaders() {
    const token = generateJwtToken();

    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
    };
}

/**
 * Convert file to base64
 */
async function fileToBase64(filePath) {
    const fileBuffer = await fs.readFile(filePath);
    return fileBuffer.toString('base64');
}

/**
 * Upload file to S3 and return presigned URL
 * Matches friend's implementation using presigned URLs
 */
async function uploadToS3(filePath, fileName, contentType) {
    if (!S3_ENABLED || !s3Client) {
        throw new Error('S3 is not configured');
    }

    try {
        const fileContent = await fs.readFile(filePath);
        const key = `kling-uploads/${Date.now()}-${fileName}`;

        // Upload to S3
        const putCommand = new PutObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: key,
            Body: fileContent,
            ContentType: contentType
        });

        await s3Client.send(putCommand);
        console.log('✅ Uploaded to S3:', key);

        // Generate presigned URL (valid for 24 hours)
        const getCommand = new GetObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key: key
        });

        const presignedUrl = await getSignedUrl(s3Client, getCommand, {
            expiresIn: parseInt(process.env.S3_URL_EXPIRATION || '86400') // 24 hours default
        });

        console.log('✅ Presigned URL generated');
        return presignedUrl;

    } catch (error) {
        console.error('S3 upload error:', error);
        throw new Error(`Failed to upload to S3: ${error.message}`);
    }
}

/**
 * Clean up uploaded files
 */
async function cleanupFiles(files) {
    for (const file of files) {
        try {
            await fs.unlink(file.path);
        } catch (error) {
            console.error('Error deleting file:', error);
        }
    }
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        message: 'EROS UNIVERSE Backend is running',
        timestamp: new Date().toISOString()
    });
});

// Generate video endpoint
app.post('/api/generate', upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'video', maxCount: 1 }
]), async (req, res) => {
    const uploadedFiles = [];

    try {
        // Validate files
        if (!req.files || !req.files.image || !req.files.video) {
            return res.status(400).json({
                success: false,
                message: 'Both image and video files are required'
            });
        }

        const imageFile = req.files.image[0];
        const videoFile = req.files.video[0];
        uploadedFiles.push(imageFile, videoFile);

        // Validate file sizes
        if (imageFile.size > 10 * 1024 * 1024) {
            return res.status(400).json({
                success: false,
                message: 'Image file must be less than 10MB'
            });
        }

        if (videoFile.size > 100 * 1024 * 1024) {
            return res.status(400).json({
                success: false,
                message: 'Video file must be less than 100MB'
            });
        }

        // Get form data
        const {
            prompt = '',
            character_orientation,
            mode,
            keep_original_sound = 'yes'
        } = req.body;

        // Validate required fields
        if (!character_orientation || !mode) {
            return res.status(400).json({
                success: false,
                message: 'character_orientation and mode are required'
            });
        }

        console.log('Processing files...');

        // Upload image to S3 and get public URL
        console.log('Uploading image to S3...');
        const imageUrl = await uploadToS3(
            imageFile.path,
            imageFile.originalname,
            imageFile.mimetype
        );

        // Upload video to S3 and get public URL
        console.log('Uploading video to S3...');
        const videoUrl = await uploadToS3(
            videoFile.path,
            videoFile.originalname,
            videoFile.mimetype
        );

        console.log('Preparing Kling AI API request...');
        console.log('Image URL:', imageUrl);
        console.log('Video URL:', videoUrl);

        // Prepare request payload for Kling AI
        const requestPayload = {
            prompt: prompt || undefined,
            image_url: imageUrl, // Public S3 URL
            video_url: videoUrl, // Public S3 URL
            character_orientation,
            mode,
            keep_original_sound
        };

        console.log('Calling Kling AI API...');
        console.log('API URL:', `${KLING_API_BASE}/v1/videos/motion-control`);
        console.log('Auth configured:', KLING_ACCESS_KEY ? '✅' : '❌');

        // Call Kling AI API
        const response = await axios.post(
            `${KLING_API_BASE}/v1/videos/motion-control`,
            requestPayload,
            {
                headers: getAuthHeaders(),
                timeout: 60000 // 60 second timeout
            }
        );

        console.log('Kling AI Response:', JSON.stringify(response.data, null, 2));

        // Clean up uploaded files
        await cleanupFiles(uploadedFiles);

        // Return success response
        res.json({
            success: true,
            message: 'Video generation task created successfully',
            task_id: response.data.data.task_id,
            task_status: response.data.data.task_status,
            created_at: response.data.data.created_at,
            external_task_id: response.data.data.task_info?.external_task_id
        });

    } catch (error) {
        // Clean up uploaded files on error
        await cleanupFiles(uploadedFiles);

        console.error('Error generating video:', error.response?.data || error.message);

        // Handle Kling AI API errors
        if (error.response?.data) {
            return res.status(error.response.status || 500).json({
                success: false,
                message: error.response.data.message || 'Kling AI API error',
                code: error.response.data.code,
                details: error.response.data
            });
        }

        // Handle other errors
        res.status(500).json({
            success: false,
            message: error.message || 'Internal server error',
            error: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// Get task status endpoint
app.get('/api/task/:taskId', async (req, res) => {
    try {
        const { taskId } = req.params;

        console.log(`Fetching task status for: ${taskId}`);

        // Call Kling AI API to get task status
        const response = await axios.get(
            `${KLING_API_BASE}/v1/videos/motion-control/${taskId}`,
            {
                headers: getAuthHeaders(),
                timeout: 30000
            }
        );

        console.log('Task Status Response:', response.data);

        res.json({
            success: true,
            data: response.data.data
        });

    } catch (error) {
        console.error('Error fetching task status:', error.response?.data || error.message);

        if (error.response?.data) {
            return res.status(error.response.status || 500).json({
                success: false,
                message: error.response.data.message || 'Failed to fetch task status',
                code: error.response.data.code
            });
        }

        res.status(500).json({
            success: false,
            message: error.message || 'Internal server error'
        });
    }
});

// Logo watermark path
const LOGO_PATH = path.join(__dirname, 'assets', 'logo.png');

/**
 * Download video with EROS UNIVERSE logo watermark
 * Fetches the generated video, overlays logo in top-right corner using ffmpeg
 */
app.get('/api/download/:taskId', async (req, res) => {
    const tempFiles = [];

    try {
        const { taskId } = req.params;
        console.log(`Downloading watermarked video for task: ${taskId}`);

        // Fetch task status to get video URL
        const taskResponse = await axios.get(
            `${KLING_API_BASE}/v1/videos/motion-control/${taskId}`,
            {
                headers: getAuthHeaders(),
                timeout: 30000
            }
        );

        const taskData = taskResponse.data.data;

        if (taskData.task_status !== 'succeed') {
            return res.status(400).json({
                success: false,
                message: 'Video is not ready yet'
            });
        }

        const videoUrl = taskData.task_result?.videos?.[0]?.url;
        if (!videoUrl) {
            return res.status(404).json({
                success: false,
                message: 'No video URL found for this task'
            });
        }

        // Verify logo exists
        if (!fsSync.existsSync(LOGO_PATH)) {
            return res.status(500).json({
                success: false,
                message: 'Logo file not found on server'
            });
        }

        // Download the video to a temp file
        const tempInput = path.join(uploadsDir, `temp-input-${taskId}-${Date.now()}.mp4`);
        const tempOutput = path.join(uploadsDir, `temp-output-${taskId}-${Date.now()}.mp4`);
        tempFiles.push(tempInput, tempOutput);

        console.log('Downloading original video...');
        const videoResponse = await axios.get(videoUrl, {
            responseType: 'arraybuffer',
            timeout: 120000 // 2 min timeout for large files
        });

        await fs.writeFile(tempInput, Buffer.from(videoResponse.data));
        console.log(`Downloaded video: ${(videoResponse.data.byteLength / 1024 / 1024).toFixed(2)} MB`);

        // Use ffmpeg to overlay logo in top-right corner
        // Logo scaled to ~10% of video width, placed with padding from top-right
        await new Promise((resolve, reject) => {
            const ffmpegPath = 'ffmpeg';
            const args = [
                '-y',
                '-i', tempInput,
                '-i', LOGO_PATH,
                '-filter_complex',
                '[1:v]scale=iw*min(160/iw\\,80/ih):-1:flags=lanczos,format=rgba,colorchannelmixer=aa=0.85[logo];[0:v][logo]overlay=W-w-20:20',
                '-codec:a', 'copy',
                '-movflags', '+faststart',
                tempOutput
            ];

            console.log('Running ffmpeg watermark overlay...');
            const proc = execFile(ffmpegPath, args, { timeout: 300000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
                if (error) {
                    console.error('ffmpeg error:', error.message);
                    console.error('ffmpeg stderr:', stderr);
                    reject(new Error(`ffmpeg failed: ${error.message}`));
                } else {
                    console.log('ffmpeg watermark complete');
                    resolve();
                }
            });
        });

        // Stream the watermarked video back
        const stat = await fs.stat(tempOutput);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Content-Disposition', `attachment; filename="eros-universe-${taskId.slice(0, 8)}.mp4"`);

        const readStream = fsSync.createReadStream(tempOutput);
        readStream.on('end', async () => {
            // Clean up temp files
            for (const f of tempFiles) {
                try { await fs.unlink(f); } catch (e) { /* ignore */ }
            }
        });
        readStream.on('error', (err) => {
            console.error('Stream error:', err);
            res.end();
        });
        readStream.pipe(res);

    } catch (error) {
        // Clean up temp files on error
        for (const f of tempFiles) {
            try { await fs.unlink(f); } catch (e) { /* ignore */ }
        }

        console.error('Download error:', error.response?.data || error.message);

        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                message: error.message || 'Failed to process video download'
            });
        }
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║           🚀 EROS UNIVERSE Backend Server            ║
║                                                       ║
║   Server running on: http://localhost:${PORT}        ║
║   Environment: ${process.env.NODE_ENV || 'development'}                        ║
║   Kling AI: ${KLING_ACCESS_KEY ? '✅ Configured' : '❌ Not Configured'}                   ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
    `);

    // Validate environment variables
    if (!KLING_ACCESS_KEY || !KLING_SECRET_KEY) {
        console.warn('⚠️  WARNING: Kling AI credentials not found in .env file');
        console.warn('   Please set KLING_ACCESS_KEY and KLING_SECRET_KEY');
    }
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
    });
});
