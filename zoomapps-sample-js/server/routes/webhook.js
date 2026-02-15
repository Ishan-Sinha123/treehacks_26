import express from 'express';
import crypto from 'crypto';

const router = express.Router();

router.post('/', async (req, res) => {
    const { event, payload } = req.body;

    // Zoom URL validation (required for webhook setup)
    if (event === 'endpoint.url_validation') {
        const hashForValidate = crypto
            .createHmac('sha256', process.env.ZOOM_SECRET_TOKEN)
            .update(req.body.payload.plainToken)
            .digest('hex');

        return res.json({
            plainToken: req.body.payload.plainToken,
            encryptedToken: hashForValidate,
        });
    }

    // Verify webhook signature
    const message = `v0:${req.headers['x-zm-request-timestamp']}:${JSON.stringify(req.body)}`;
    const hashForVerify = crypto
        .createHmac('sha256', process.env.ZOOM_SECRET_TOKEN)
        .update(message)
        .digest('hex');
    const signature = `v0=${hashForVerify}`;

    if (req.headers['x-zm-signature'] !== signature) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    // Handle transcription events
    if (event === 'meeting.transcription_completed') {
        console.log('Transcription completed:', JSON.stringify(payload, null, 2));
        // TODO: process the transcription with your Anthropic API key here
        // The payload contains download_url for the transcript file
    }

    res.status(200).json({ message: 'OK' });
});

export default router;
