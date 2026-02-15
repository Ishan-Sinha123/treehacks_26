import express from 'express';
import crypto from 'crypto';
import rtms from '@zoom/rtms';
import debug from 'debug';
import { appName, zmSecretToken, zoomApp } from '../../config.js';
import { bulkInsertSegments } from '../helpers/elasticsearch.js';

const router = express.Router();
const dbg = debug(`${appName}:webhook`);

// Track active RTMS clients by stream ID
const activeClients = new Map();

// Set RTMS SDK env vars from our config
process.env.ZM_RTMS_CLIENT = zoomApp.clientId;
process.env.ZM_RTMS_SECRET = zoomApp.clientSecret;

/**
 * POST /webhook
 * Receives Zoom webhook events (RTMS start/stop, URL validation)
 */
router.post('/', (req, res) => {
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

    // Handle RTMS events
    if (event === 'meeting.rtms_started') {
        handleRTMSStarted(payload);
    } else if (event === 'meeting.rtms_stopped') {
        handleRTMSStopped(payload);
    }
});

/**
 * Handle meeting.rtms_started webhook
 * Creates an RTMS client and connects to receive transcript data
 */
function handleRTMSStarted(payload) {
    const { meeting_uuid, rtms_stream_id } = payload;
    dbg(`RTMS started for meeting: ${meeting_uuid}, stream: ${rtms_stream_id}`);

    // Prevent duplicate connections
    if (activeClients.has(rtms_stream_id)) {
        dbg(`Stream ${rtms_stream_id} already active, skipping`);
        return;
    }

    const client = new rtms.Client();
    const batch = [];
    let batchTimer = null;

    function flushBatch() {
        if (batch.length === 0) return;

        const toInsert = [...batch];
        batch.length = 0;

        dbg(`Flushing ${toInsert.length} segments to Elasticsearch`);
        bulkInsertSegments(toInsert).catch((err) => {
            console.error('Error inserting segments:', err);
        });
    }

    // Receive transcript data
    client.onTranscriptData((data, timestamp, metadata) => {
        const text = data.toString('utf8');
        dbg(
            `Transcript from ${
                metadata.userName || 'Unknown'
            }: ${text.substring(0, 50)}...`
        );

        const segment = {
            meeting_id: meeting_uuid,
            speaker_id: String(metadata.userId || 'unknown'),
            speaker_name: metadata.userName || 'Unknown',
            text,
            timestamp: new Date(Number(timestamp)),
            segment_id: `${meeting_uuid}-${Date.now()}-${Math.random()
                .toString(36)
                .substr(2, 9)}`,
        };

        batch.push(segment);

        // Flush batch after 1 second of accumulation
        if (batchTimer) clearTimeout(batchTimer);
        batchTimer = setTimeout(flushBatch, 1000);
    });

    client.onJoinConfirm((reason) => {
        dbg(`Joined RTMS session: ${reason}`);
    });

    client.onLeave((reason) => {
        dbg(`Left RTMS session: ${reason}`);
        flushBatch();
        activeClients.delete(rtms_stream_id);
    });

    // Connect to RTMS with transcript media type
    client.join(payload);
    activeClients.set(rtms_stream_id, client);

    dbg(`RTMS client connected for stream: ${rtms_stream_id}`);
}

/**
 * Handle meeting.rtms_stopped webhook
 */
function handleRTMSStopped(payload) {
    const { rtms_stream_id } = payload;
    dbg(`RTMS stopped for stream: ${rtms_stream_id}`);

    const client = activeClients.get(rtms_stream_id);
    if (client) {
        client.leave();
        activeClients.delete(rtms_stream_id);
    }
}

export default router;
