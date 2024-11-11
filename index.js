require('dotenv').config();

const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const AWS = require('aws-sdk');

// Configure AWS with your credentials and region
const s3 = new AWS.S3({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION
});

// Setup Express app
const app = express();
app.use(express.json({ limit: '50mb' })); // Adjust limit as necessary
const port = 3000;

// Configure Multer to handle file uploads
const upload = multer({
    dest: path.join(__dirname, 'uploads'),
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        // Allow only audio files
        if (ext !== '.mp3' && ext !== '.wav' && ext !== '.m4a') {
            return cb(new Error('Only audio files are allowed'));
        }
        cb(null, true);
    }
});

// Endpoint to handle byte data and transcribe it
// app.post('/transcribe-bytes', upload.none(), async (req, res) => {
//     try {
//         if (!req.body || !req.body.audio) {
//             return res.status(400).json({ error: 'Audio data is required in the request body' });
//         }

//         const audioBytes = req.body.audio;
//         const buffer = Buffer.from(audioBytes, 'base64');
//         const mp3Path = path.join(__dirname, 'uploads', 'temp_audio.mp3');

//         fs.writeFileSync(mp3Path, buffer);

//         const command = `whisper ${mp3Path} --model tiny --language en --output_dir uploads --output_format json`;

//         exec(command, async (error, stdout, stderr) => {
//             if (error) {
//                 console.error(`Error: ${error.message}`);
//                 return res.status(500).json({ error: 'Failed to transcribe audio' });
//             }

//             const outputJsonPath = path.join(__dirname, 'uploads', 'temp_audio.json');
//             let transcriptionData;

//             try {
//                 transcriptionData = JSON.parse(fs.readFileSync(outputJsonPath, 'utf-8'));
//                 console.log('Transcription Data:', transcriptionData); // Log transcription data to inspect
//             } catch (jsonError) {
//                 console.error('Error reading or parsing JSON:', jsonError);
//                 return res.status(500).json({ error: 'Failed to read or parse transcription data' });
//             }

//             // Check if transcriptionData has the expected structure
//             if (!transcriptionData || !transcriptionData.segments || !Array.isArray(transcriptionData.segments)) {
//                 return res.status(500).json({ error: 'Invalid transcription data structure, "segments" not found' });
//             }

//             // Format the transcription as specified
//             const formattedText = transcriptionData.segments
//                 .map(segment => `[${segment.start} - ${segment.end}] ${segment.text}`)
//                 .join('\n\n');

//             console.log('Formatted Text:', formattedText); // Log formatted text

//             // Ensure formattedText is a string before converting to Buffer
//             if (typeof formattedText !== 'string') {
//                 console.error('Formatted text is not a string:', formattedText);
//                 return res.status(500).json({ error: 'Formatted text is not a string' });
//             }

//             const textBuffer = Buffer.from(formattedText, 'utf-8');
//             const s3Params = {
//                 Bucket: 'android-audio-app-bucket', // Replace with your bucket name
//                 Key: `transcriptions/whisper_${Date.now()}_transcription.txt`, // Generate a unique file name
//                 Body: textBuffer,
//                 ContentType: 'text/plain'
//             };

//             // Upload the file to S3
//             try {
//                 await s3.upload(s3Params).promise();
//                 res.json({ message: 'Transcription saved to S3 successfully.' });
//             } catch (s3Error) {
//                 console.error(`S3 Upload Error: ${s3Error.message}`);
//                 res.status(500).json({ error: 'Failed to upload transcription to S3' });
//             } finally {
//                 fs.unlinkSync(mp3Path);
//                 fs.unlinkSync(outputJsonPath);
//             }
//         });
//     } catch (err) {
//         console.error('General error:', err);
//         res.status(500).json({ error: 'Failed to process audio data' });
//     }
// });

// Function to adjust timestamps using float seconds
const adjustTimestamp = (lastEndTimeInSeconds, segment) => {
    // Add the previous chunk's end time to the new chunk's start time
    const adjustedStartTimeInSeconds = lastEndTimeInSeconds + segment.start;

    // Update segment.start with the new adjusted start time in float seconds
    segment.start = adjustedStartTimeInSeconds;

    return segment;
};

// Convert seconds to mm:ss format (if needed)
const convertToMMSS = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    return `${minutes}:${remainingSeconds < 10 ? '0' + remainingSeconds : remainingSeconds}`;
};

// Endpoint to handle byte data and transcribe it
app.post('/transcribe-bytes', async (req, res) => {
    try {
        if (!req.body || !req.body.audio || !req.body.identifier) {
            return res.status(400).json({ error: 'Audio data and identifier are required in the request body' });
        }

        const audioBytes = req.body.audio;
        const identifier = req.body.identifier; // Get the unique identifier for the audio chunk
        const buffer = Buffer.from(audioBytes, 'base64');
        const mp3Path = path.join(__dirname, 'uploads', `${identifier}_temp_audio.mp3`);

        // Save the audio buffer as a temporary mp3 file
        fs.writeFileSync(mp3Path, buffer);

        const command = `whisper ${mp3Path} --model tiny --language en --output_dir uploads --output_format json --beam_size 5`;

        exec(command, async (error, stdout, stderr) => {
            if (error) {
                console.error(`Error: ${error.message}`);
                return res.status(500).json({ error: 'Failed to transcribe audio' });
            }

            const outputJsonPath = path.join(__dirname, 'uploads', `${identifier}_temp_audio.json`);
            let transcriptionData;

            try {
                transcriptionData = JSON.parse(fs.readFileSync(outputJsonPath, 'utf-8'));
                // console.log('Transcription Data:', transcriptionData); // Log transcription data to inspect
            } catch (jsonError) {
                console.error('Error reading or parsing JSON:', jsonError);
                return res.status(500).json({ error: 'Failed to read or parse transcription data' });
            }

            // Path to the S3 object where the transcription is stored (associated with the identifier)
            const s3TranscriptionPath = `transcriptions/${identifier}_transcription.txt`;
            const s3TranscriptionPathJson = `transcriptions/${identifier}_transcription.json`;

            let existingTranscriptionData = [];
            let existingTranscriptionDataTxt = "";
            let lastEndTime = 0; // Default start time for the first chunk

            try {
                // Check if the transcription file already exists in S3
                const existingFile = await s3.getObject({
                    Bucket: 'android-audio-app-bucket', // Replace with your bucket name
                    Key: s3TranscriptionPathJson // Ensure this points to the correct JSON file
                }).promise();

                try {
                    // Parse the JSON data from the file
                    existingTranscriptionData = JSON.parse(existingFile.Body.toString('utf-8'));

                    // Assuming the transcription data has a "segments" field containing an array of segments
                    if (existingTranscriptionData.segments && existingTranscriptionData.segments.length > 0) {
                        const lastSegment = existingTranscriptionData.segments[existingTranscriptionData.segments.length - 1];
                        lastEndTime = lastSegment.end; // Get the end time of the last segment
                    }
                } catch (err) {
                    console.error('Error parsing transcription JSON:', err);
                    return res.status(500).json({ error: 'Failed to read or parse transcription data' });
                }

                // Retrieve TXT
                // Check if the transcription file already exists in S3
                const existingFileTxt = await s3.getObject({
                    Bucket: 'android-audio-app-bucket', // Replace with your bucket name
                    Key: s3TranscriptionPath // Ensure this points to the correct JSON file
                }).promise();

                try {
                    // Parse the JSON data from the file
                    existingTranscriptionDataTxt = (existingFileTxt.Body.toString('utf-8'));
                } catch (err) {
                    console.error('Error parsing transcription TXT:', err);
                    return res.status(500).json({ error: 'Failed to read or parse transcription data' });
                }

                // console.log('Last End Time:', lastEndTime);
            } catch (err) {
                // If the file does not exist, S3 will throw an error which we can ignore to create a new file
                if (err.code !== 'NoSuchKey') {
                    console.error('Error reading existing transcription file from S3:', err);
                    return res.status(500).json({ error: 'Failed to read transcription file from S3' });
                }
            }

            // Adjust the timestamps and format the transcription text
            const newSegments = transcriptionData.segments || [];
            newSegments.forEach(segment => {
                // Adjust the start time for each new segment based on the last end time
                adjustTimestamp(lastEndTime, segment);
                // lastEndTime = segment.end; // Update lastEndTime to the current segment's end time

                // Push new segment to existing array
                existingTranscriptionData.push(segment)
            });

            let formattedText = newSegments
                .map(segment => `[${convertToMMSS(segment.start)} - ${convertToMMSS(segment.end)}] ${segment.text}`)
                .join('\n\n');

            formattedText = existingTranscriptionDataTxt + '\n\n' + formattedText; // concat previos transcription text + new one

            // console.log('Updated Transcription:', formattedText); // Log updated transcription

            // Save the formatted transcription text to S3
            const s3Params = {
                Bucket: 'android-audio-app-bucket', // Replace with your bucket name
                Key: s3TranscriptionPath, // Use the identifier to ensure unique filenames
                Body: formattedText,
                ContentType: 'text/plain'
            };


            // Save the transcription JSON to S3
            const s3ParamsJson = {
                Bucket: 'android-audio-app-bucket', // Replace with your bucket name
                Key: s3TranscriptionPathJson, // Use the identifier to ensure unique filenames
                Body: JSON.stringify(existingTranscriptionData),
                ContentType: 'text/plain'
            };

            try {
                await s3.upload(s3Params).promise();
                await s3.upload(s3ParamsJson).promise();
                res.json({ message: 'Transcription saved to S3 successfully.' });
            } catch (s3Error) {
                console.error(`S3 Upload Error: ${s3Error.message}`);
                res.status(500).json({ error: 'Failed to upload transcription to S3' });
            } finally {
                // Clean up temporary files from server
                fs.unlinkSync(mp3Path);
                fs.unlinkSync(outputJsonPath);
            }
        });
    } catch (err) {
        console.error('General error:', err);
        res.status(500).json({ error: 'Failed to process audio data' });
    }
});

// Route to upload audio file and transcribe it using Whisper
app.post('/transcribe', upload.single('audio'), (req, res) => {
    if (!req.file) {
        res.status(400).send('No file uploaded or file is empty.');
    }
    const audioFile = req.file.path;

    // Call the Whisper command using the file path
    const pythonCommand = `whisper ${audioFile} --model tiny --language en --output_dir uploads --output_format json`;

    exec(pythonCommand, (error, stdout, stderr) => {
        // Cleanup uploaded file in case of an error
        const cleanUp = () => {
            try {
                fs.unlinkSync(audioFile);
            } catch (unlinkError) {
                console.error(`Failed to delete file: ${unlinkError}`);
            }
        };

        if (error) {
            console.error(`Error executing Whisper: ${error.message}`);
            cleanUp();
            return res.status(500).json({ error: 'Error during transcription', details: stderr });
        }

        // Parse the transcription result (stdout)
        try {
            return res.json({ result: stdout });
            const result = JSON.parse(stdout);
            cleanUp(); // Clean up the uploaded audio file
            return res.json(result);
        } catch (err) {
            console.error(`Error parsing Whisper output: ${stderr}`);
            cleanUp();
            return res.status(500).json({ error: 'Error parsing transcription result' });
        }
    });
});

app.get('/', (req, res) => {
    res.send('Hello World!');
});

app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});