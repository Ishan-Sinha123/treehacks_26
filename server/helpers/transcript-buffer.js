import { EventEmitter } from 'events';

const SUMMARY_INTERVAL_MS = 30_000; // summarize every 30s
const CHUNK_INTERVAL_MS = 60_000; // flush chunk every 60s
const CHUNK_WORD_THRESHOLD = 500; // or when 500+ words accumulated
const SPEAKER_IDLE_MS = 10_000; // summarize when speaker idle 10s

export class TranscriptBuffer extends EventEmitter {
    constructor(meetingId) {
        super();
        this.meetingId = meetingId;
        this.utterances = []; // raw buffer
        this.speakerLastSummarized = new Map(); // speakerId -> index
        this.speakerIdleTimers = new Map(); // speakerId -> timerId
        this.lastChunkFlush = Date.now();
        this.wordCount = 0;
        this.chunkSeq = 0;

        // Periodic summary timer
        this.summaryTimer = setInterval(
            () => this._triggerSummaries(),
            SUMMARY_INTERVAL_MS
        );

        // Periodic chunk timer
        this.chunkTimer = setInterval(
            () => this._triggerChunkFlush(),
            CHUNK_INTERVAL_MS
        );
    }

    append({ speakerId, speakerName, text, timestamp }) {
        this.utterances.push({ speakerId, speakerName, text, timestamp });
        this.wordCount += text.split(/\s+/).length;

        // Reset idle timer for this speaker
        if (this.speakerIdleTimers.has(speakerId)) {
            clearTimeout(this.speakerIdleTimers.get(speakerId));
        }
        this.speakerIdleTimers.set(
            speakerId,
            setTimeout(
                () => this._triggerSpeakerSummary(speakerId),
                SPEAKER_IDLE_MS
            )
        );

        // Check word threshold for chunk flush
        if (this.wordCount >= CHUNK_WORD_THRESHOLD) {
            this._triggerChunkFlush();
        }
    }

    // --- Trigger A: Speaker Summaries ---

    _triggerSummaries() {
        const speakersWithNew = new Set();
        for (let i = 0; i < this.utterances.length; i++) {
            const u = this.utterances[i];
            const lastIdx = this.speakerLastSummarized.get(u.speakerId) ?? -1;
            if (i > lastIdx) {
                speakersWithNew.add(u.speakerId);
            }
        }
        for (const speakerId of speakersWithNew) {
            this._triggerSpeakerSummary(speakerId);
        }
    }

    _triggerSpeakerSummary(speakerId) {
        const lastIdx = this.speakerLastSummarized.get(speakerId) ?? -1;
        const unsummarized = [];
        let speakerName = '';

        for (let i = lastIdx + 1; i < this.utterances.length; i++) {
            const u = this.utterances[i];
            if (u.speakerId === speakerId) {
                unsummarized.push(u);
                speakerName = u.speakerName;
            }
        }

        if (unsummarized.length === 0) return;

        const recentText = unsummarized.map((u) => u.text).join(' ');

        // Count total utterances for this speaker
        const totalCount = this.utterances.filter(
            (u) => u.speakerId === speakerId
        ).length;

        this.emit('summarize', {
            meetingId: this.meetingId,
            speakerId,
            speakerName,
            recentText,
            segmentCount: totalCount,
        });

        // Mark as summarized up to current end
        this.speakerLastSummarized.set(speakerId, this.utterances.length - 1);

        // Clear idle timer
        if (this.speakerIdleTimers.has(speakerId)) {
            clearTimeout(this.speakerIdleTimers.get(speakerId));
            this.speakerIdleTimers.delete(speakerId);
        }
    }

    // --- Trigger B: Content Chunk ---

    _triggerChunkFlush() {
        if (this.utterances.length === 0) return;

        const speakerIds = [
            ...new Set(this.utterances.map((u) => u.speakerId)),
        ];
        const speakerNames = [
            ...new Set(this.utterances.map((u) => u.speakerName)),
        ];
        const text = this.utterances
            .map((u) => `${u.speakerName}: ${u.text}`)
            .join('\n');
        const startTime = this.utterances[0].timestamp;
        const endTime = this.utterances[this.utterances.length - 1].timestamp;

        this.chunkSeq++;
        const chunkId = `${this.meetingId}-chunk-${this.chunkSeq}`;

        console.log(
            `📤 Flushing chunk ${chunkId} (${this.utterances.length} utterances, ${this.wordCount} words)`
        );

        this.emit('chunk', {
            meeting_id: this.meetingId,
            text,
            speaker_ids: speakerIds,
            speaker_names: speakerNames,
            start_time: startTime,
            end_time: endTime,
            chunk_id: chunkId,
        });

        // Clear buffer
        this.utterances = [];
        this.wordCount = 0;
        this.lastChunkFlush = Date.now();
        // Reset summarization indices since buffer was cleared
        this.speakerLastSummarized.clear();
    }

    destroy() {
        clearInterval(this.summaryTimer);
        clearInterval(this.chunkTimer);
        for (const timerId of this.speakerIdleTimers.values()) {
            clearTimeout(timerId);
        }
        this.speakerIdleTimers.clear();
        // Flush remaining data
        this._triggerSummaries();
        this._triggerChunkFlush();
        this.removeAllListeners();
    }
}

// Registry of active buffers (one per meeting)
const buffers = new Map();

export function getOrCreateBuffer(meetingId) {
    if (!buffers.has(meetingId)) {
        buffers.set(meetingId, new TranscriptBuffer(meetingId));
    }
    return buffers.get(meetingId);
}

export function destroyBuffer(meetingId) {
    const buffer = buffers.get(meetingId);
    if (buffer) {
        buffer.destroy();
        buffers.delete(meetingId);
    }
}
