import express from 'express';
import { WebSocketServer } from 'ws';
import debug from 'debug';
import { appName } from '../../config.js';
import { insertTranscriptChunk } from '../helpers/elasticsearch.js';
import {
    getOrCreateBuffer,
    destroyBuffer,
} from '../helpers/transcript-buffer.js';
import { summarizeSpeaker } from '../helpers/summarizer.js';

const router = express.Router();
const dbg = debug(`${appName}:rtms`);

// Track which meetings have buffer events wired
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
 * Initialize WebSocket server for RTMS
 * @param {http.Server} server - HTTP server instance
 */
export function initializeRTMSWebSocket(server) {
    const wss = new WebSocketServer({
        server,
        path: '/rtms',
    });

    wss.on('connection', (ws, req) => {
        const meetingId = req.url.split('?meetingId=')[1];

        if (!meetingId) {
            dbg('❌ No meeting ID provided');
            ws.close(1008, 'Meeting ID required');
            return;
        }

        dbg(`✅ RTMS WebSocket connected for meeting: ${meetingId}`);
        wireBufferEvents(meetingId);

        ws.on('message', async (data) => {
            try {
                const transcript = JSON.parse(data.toString());
                dbg(
                    `📝 Received transcript from ${
                        transcript.speaker_name || 'Unknown'
                    }`
                );

                const buffer = getOrCreateBuffer(meetingId);
                buffer.append({
                    speakerId:
                        transcript.speaker_id ||
                        String(transcript.userId || 'unknown'),
                    speakerName:
                        transcript.speaker_name ||
                        transcript.userName ||
                        'Unknown',
                    text: transcript.text,
                    timestamp: new Date().toISOString(),
                });
            } catch (error) {
                console.error('Error processing RTMS message:', error);
            }
        });

        ws.on('close', () => {
            dbg(`🔌 RTMS WebSocket closed for meeting: ${meetingId}`);
            destroyBuffer(meetingId);
            wiredMeetings.delete(meetingId);
        });

        ws.on('error', (error) => {
            console.error('RTMS WebSocket error:', error);
        });
    });

    dbg('✅ RTMS WebSocket server initialized');
}

export default router;
