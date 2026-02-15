import express from 'express';
import crypto from 'crypto';
import debug from 'debug';
import { appName, zmSecretToken, zoomApp } from '../../config.js';
import { RTMSManager } from '../rtmsManager/index.js';
import { insertTranscriptChunk } from '../helpers/elasticsearch.js';
import {
    getOrCreateBuffer,
    destroyBuffer,
} from '../helpers/transcript-buffer.js';
import { summarizeSpeaker } from '../helpers/summarizer.js';

const router = express.Router();
const dbg = debug(`${appName}:webhook`);

let rtmsInitialized = false;

/**
 * Initialize RTMSManager singleton on first use
 */
async function ensureRTMSInitialized() {
    if (rtmsInitialized) return;

    await RTMSManager.init({
        credentials: {
            meeting: {
                clientId: zoomApp.clientId,
                clientSecret: zoomApp.clientSecret,
                secretToken: zmSecretToken,
            },
        },
        mediaTypes: RTMSManager.MEDIA.TRANSCRIPT,
        logging: 'info',
    });

    // Listen for transcript events from RTMSManager
    RTMSManager.on('transcript', (eventData) => {
        console.log(
            `📝 TRANSCRIPT [${eventData.userName || 'Unknown'}]: ${
                eventData.text || '(empty)'
            }`
        );

        const buffer = getOrCreateBuffer(eventData.meetingId);

        buffer.append({
            speakerId: String(eventData.userId || 'unknown'),
            speakerName: eventData.userName || 'Unknown',
            text: eventData.text,
            timestamp: new Date().toISOString(),
        });
    });

    rtmsInitialized = true;
    console.log('✅ RTMSManager initialized for transcript capture');
}

/**
 * Wire buffer events for a meeting (idempotent — checks if already wired)
 */
const wiredMeetings = new Set();

function wireBufferEvents(meetingId) {
    if (wiredMeetings.has(meetingId)) return;
    wiredMeetings.add(meetingId);

    const buffer = getOrCreateBuffer(meetingId);

    buffer.on('chunk', async (chunkData) => {
        try {
            await insertTranscriptChunk(chunkData);
        } catch (err) {
            console.error('❌ Error inserting chunk:', err.message);
        }
    });

    buffer.on('summarize', async (summaryData) => {
        try {
            const result = await summarizeSpeaker(summaryData);
            console.log(
                `📝 Speaker summary updated: ${
                    summaryData.speakerName
                }\n   Topics: ${result.topics.join(', ')}\n   Summary: ${
                    result.summary
                }`
            );
        } catch (err) {
            console.error('❌ Error summarizing speaker:', err.message);
        }
    });
}

/**
 * POST /webhook
 * Receives Zoom webhook events (RTMS start/stop, URL validation)
 */
router.post('/', async (req, res) => {
    const { event, payload } = req.body;

    dbg(`Webhook received: ${event}`);

    // Handle Zoom URL validation challenge
    if (event === 'endpoint.url_validation' && payload?.plainToken) {
        const hash = crypto
            .createHmac('sha256', zmSecretToken)
            .update(payload.plainToken)
            .digest('hex');

        dbg('URL validation challenge responded');
        return res.json({
            plainToken: payload.plainToken,
            encryptedToken: hash,
        });
    }

    // Respond immediately to avoid Zoom retries
    res.status(200).json({ status: 'accepted' });

    // Initialize RTMSManager if needed
    await ensureRTMSInitialized();

    // Forward event to RTMSManager — it handles the RTMS connection lifecycle
    if (event === 'meeting.rtms_started') {
        const meetingId = payload?.object?.id || payload?.object?.meeting_id;
        if (meetingId) wireBufferEvents(String(meetingId));
        dbg(`Forwarding ${event} to RTMSManager`);
        RTMSManager.handleEvent(event, payload);
    } else if (event === 'meeting.rtms_stopped') {
        const meetingId = payload?.object?.id || payload?.object?.meeting_id;
        if (meetingId) {
            destroyBuffer(String(meetingId));
            wiredMeetings.delete(String(meetingId));
        }
        dbg(`Forwarding ${event} to RTMSManager`);
        RTMSManager.handleEvent(event, payload);
    }
});

export default router;
