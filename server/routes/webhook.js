import express from 'express';
import crypto from 'crypto';
import debug from 'debug';
import { appName, zmSecretToken, zoomApp } from '../../config.js';
import { RTMSManager } from '../rtmsManager/index.js';
import { insertTranscriptChunk, esClient } from '../helpers/elasticsearch.js';
import {
    getOrCreateBuffer,
    destroyBuffer,
} from '../helpers/transcript-buffer.js';
import { summarizeSpeaker } from '../helpers/summarizer.js';

const router = express.Router();
const dbg = debug(`${appName}:webhook`);

let rtmsInitialized = false;

// Map numeric meeting ID → UUID (in-memory cache, backed by ES)
const meetingIdToUuid = new Map();

export async function getMeetingUuid(numericId) {
    const key = String(numericId);

    // 1. Check in-memory cache
    if (meetingIdToUuid.has(key)) {
        console.log(
            `🔍 getMeetingUuid: "${key}" → ${meetingIdToUuid.get(
                key
            )} (from cache)`
        );
        return meetingIdToUuid.get(key);
    }

    // 2. Fall back to ES meetings index
    try {
        const result = await esClient.search({
            index: 'meetings',
            body: {
                query: { term: { meeting_id: key } },
                size: 1,
            },
        });

        const hit = result.hits.hits[0];
        if (hit?._source?.meeting_uuid) {
            const uuid = hit._source.meeting_uuid;
            meetingIdToUuid.set(key, uuid); // cache it
            console.log(`🔍 getMeetingUuid: "${key}" → ${uuid} (from ES)`);
            return uuid;
        }
    } catch (err) {
        console.warn(
            `🔍 getMeetingUuid: ES lookup failed for "${key}":`,
            err.message
        );
    }

    console.log(`🔍 getMeetingUuid: "${key}" → NOT FOUND (cache + ES)`);
    return null;
}

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

        const meetingId = String(eventData.meetingId);
        console.log(
            `📝 RTMSManager eventData.meetingId = "${meetingId}" (type: ${typeof eventData.meetingId})`
        );
        wireBufferEvents(meetingId);
        const buffer = getOrCreateBuffer(meetingId);

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
        // Log the full payload.object so we can see all available fields
        console.log(
            '📦 meeting.rtms_started payload.object keys:',
            Object.keys(payload?.object || {}),
            JSON.stringify(payload?.object, null, 2)
        );

        // Capture numeric meeting ID → UUID mapping
        // Payload fields: payload.object.meeting_id (numeric), payload.object.meeting_uuid (base64)
        const numericId = payload?.object?.meeting_id;
        const uuid = payload?.object?.meeting_uuid;
        if (numericId && uuid) {
            meetingIdToUuid.set(String(numericId), uuid);
            console.log(
                `📌 Meeting ID mapping cached: "${numericId}" → "${uuid}"`
            );

            // Persist to ES meetings index (survives server restarts)
            try {
                await esClient.index({
                    index: 'meetings',
                    id: String(numericId),
                    body: {
                        meeting_id: String(numericId),
                        meeting_uuid: uuid,
                        start_time: new Date().toISOString(),
                        status: 'active',
                    },
                });
                console.log(`📌 Meeting ID mapping persisted to ES`);
            } catch (esErr) {
                console.error(
                    '❌ Failed to persist meeting mapping to ES:',
                    esErr.message
                );
            }
        } else {
            console.log(
                `⚠️ RTMS started — missing fields! meeting_id=${numericId}, meeting_uuid=${uuid}`
            );
            console.log('⚠️ Full payload:', JSON.stringify(payload, null, 2));
        }
        dbg(`Forwarding ${event} to RTMSManager`);
        RTMSManager.handleEvent(event, payload);
    } else if (event === 'meeting.rtms_stopped') {
        // Clean up using UUID (buffers/wiredMeetings are keyed by UUID)
        const numericId = payload?.object?.meeting_id;
        const uuid = meetingIdToUuid.get(String(numericId));
        const cleanupId = uuid || numericId;
        if (cleanupId) {
            destroyBuffer(String(cleanupId));
            wiredMeetings.delete(String(cleanupId));
        }
        // Clean up the mapping too
        if (numericId) {
            meetingIdToUuid.delete(String(numericId));
        }
        dbg(`Forwarding ${event} to RTMSManager`);
        RTMSManager.handleEvent(event, payload);
    }
});

export default router;
