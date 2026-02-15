import express from 'express';
import crypto from 'crypto';
import debug from 'debug';
import { appName, zmSecretToken, zoomApp } from '../../config.js';
import { RTMSManager } from '../rtmsManager/index.js';
import { bulkInsertSegments } from '../helpers/elasticsearch.js';

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

    // Batch accumulator for ES inserts
    let batch = [];
    let batchTimer = null;

    function flushBatch() {
        if (batch.length === 0) return;
        const toInsert = [...batch];
        batch = [];
        console.log(`📤 Flushing ${toInsert.length} segments to Elasticsearch`);
        bulkInsertSegments(toInsert)
            .then(() => {
                console.log(
                    `✅ Successfully inserted ${toInsert.length} segments`
                );
            })
            .catch((err) => {
                console.error('❌ Error inserting segments:', err);
            });
    }

    // Listen for transcript events from RTMSManager
    RTMSManager.on('transcript', (eventData) => {
        console.log(
            `📝 TRANSCRIPT [${eventData.userName || 'Unknown'}]: ${
                eventData.text || '(empty)'
            }`
        );

        const segment = {
            meeting_id: eventData.meetingId,
            speaker_id: String(eventData.userId || 'unknown'),
            speaker_name: eventData.userName || 'Unknown',
            text: eventData.text,
            timestamp: new Date().toISOString(), // ✅ FIXED
            segment_id: `${eventData.meetingId}-${Date.now()}-${Math.random()
                .toString(36)
                .substr(2, 9)}`,
        };

        console.log(`➕ Added to batch (batch size: ${batch.length + 1})`);
        batch.push(segment);

        if (batchTimer) clearTimeout(batchTimer);
        batchTimer = setTimeout(flushBatch, 1000);
    });

    rtmsInitialized = true;
    console.log('✅ RTMSManager initialized for transcript capture');
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
    if (event === 'meeting.rtms_started' || event === 'meeting.rtms_stopped') {
        dbg(`Forwarding ${event} to RTMSManager`);
        RTMSManager.handleEvent(event, payload);
    }
});

export default router;
