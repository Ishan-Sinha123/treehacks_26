import zoomSdk from '@zoom/appssdk';

// State
let participants = [];
let inImmersiveView = false;
let isChatProcessing = false;
let meetingId = null;
let screenName = null;
let pollInterval = null;

// Get components
const mainContent = document.getElementById('main');
const toggleButton = document.getElementById('toggle-view');
const immersiveContainer = document.getElementById('immersive');
const chatInput = document.getElementById('chat-input');
const chatSubmit = document.getElementById('chat-submit');
const chatMessages = document.getElementById('chat-messages');

const participant1Name = document.getElementById('participant-1-name');
const participant2Name = document.getElementById('participant-2-name');
const participant3Name = document.getElementById('participant-3-name');
const participant4Name = document.getElementById('participant-4-name');
const participantNames = [
    participant1Name,
    participant2Name,
    participant3Name,
    participant4Name,
];

// Context summary elements (immersive view)
const participantSummaries = [
    document.getElementById('participant-1-summary'),
    document.getElementById('participant-2-summary'),
    document.getElementById('participant-3-summary'),
    document.getElementById('participant-4-summary'),
];

// Context buttons and containers
const showContextButtons = [
    document.getElementById('show-participant-1-context'),
    document.getElementById('show-participant-2-context'),
    document.getElementById('show-participant-3-context'),
    document.getElementById('show-participant-4-context'),
];

const hideContextButtons = [
    document.getElementById('hide-participant-1-context'),
    document.getElementById('hide-participant-2-context'),
    document.getElementById('hide-participant-3-context'),
    document.getElementById('hide-participant-4-context'),
];

const contextContainers = [
    document.getElementById('user-1-context'),
    document.getElementById('user-2-context'),
    document.getElementById('user-3-context'),
    document.getElementById('user-4-context'),
];

/**
 * Initialize context toggle buttons
 */
function initializeContextToggle() {
    // Set up show button listeners
    for (let i = 0; i < showContextButtons.length; i++) {
        if (showContextButtons[i] && contextContainers[i]) {
            showContextButtons[i].addEventListener('click', () => {
                contextContainers[i].classList.remove('is-hidden');
                showContextButtons[i].classList.add('is-hidden');
            });
        }
    }

    // Set up hide button listeners
    for (let i = 0; i < hideContextButtons.length; i++) {
        if (hideContextButtons[i] && contextContainers[i]) {
            hideContextButtons[i].addEventListener('click', () => {
                contextContainers[i].classList.add('is-hidden');
                showContextButtons[i].classList.remove('is-hidden');
            });
        }
    }
}

/**
 * Poll speakers from backend and update UI
 */
async function pollSpeakers() {
    if (!meetingId) return;

    try {
        const response = await fetch(`/api/meeting/${meetingId}/speakers`);
        if (!response.ok) return;
        const data = await response.json();
        const speakers = data.speakers || [];

        if (speakers.length === 0) return;

        // Update immersive view participant summaries
        // Match speakers to participant slots by name
        for (let i = 0; i < participantNames.length; i++) {
            const slotName = participantNames[i]?.textContent?.trim();
            if (!slotName || slotName === `Participant ${i + 1}`) continue;

            const matched = speakers.find(
                (s) =>
                    s.speaker_name &&
                    slotName
                        .toLowerCase()
                        .includes(s.speaker_name.toLowerCase())
            );

            if (matched && participantSummaries[i]) {
                participantSummaries[i].textContent =
                    matched.context_summary || 'No summary yet.';
            }
        }

        // Update timeline with topics from all speakers
        updateTimeline(speakers);
    } catch (error) {
        console.error('Failed to poll speakers:', error);
    }
}

/**
 * Update the timeline with real topics from speakers
 */
function updateTimeline(speakers) {
    const timeline = document.getElementById('timeline');
    if (!timeline) return;

    // Collect all topics from all speakers
    const allTopics = [];
    for (const speaker of speakers) {
        if (speaker.topics && Array.isArray(speaker.topics)) {
            for (const topic of speaker.topics) {
                if (!allTopics.includes(topic)) {
                    allTopics.push(topic);
                }
            }
        }
    }

    if (allTopics.length === 0) return;

    // Clear existing timeline items (keep the spacer div at the end)
    while (timeline.children.length > 1) {
        timeline.removeChild(timeline.firstChild);
    }

    // Add topic boxes
    const spacer = timeline.lastElementChild;
    for (const topic of allTopics) {
        const box = document.createElement('div');
        box.className = 'box content ml-3';
        const p = document.createElement('p');
        p.textContent = topic;
        box.appendChild(p);
        timeline.insertBefore(box, spacer);
    }
}

/**
 * Start polling for speaker data
 */
function startPolling() {
    if (pollInterval) clearInterval(pollInterval);
    // Poll immediately, then every 5 seconds
    pollSpeakers();
    pollInterval = setInterval(pollSpeakers, 5000);
}

// Initialize app
(async () => {
    try {
        const configResponse = await zoomSdk.config({
            capabilities: [
                'startRTMS',
                'stopRTMS',
                'runRenderingContext',
                'closeRenderingContext',
                'drawParticipant',
                'clearParticipant',
                'getMeetingParticipants',
                'getUserContext',
                'getMeetingContext',
                'onParticipantChange',
            ],
        });

        console.debug('Zoom JS SDK Configuration', configResponse);

        // Capture meetingId
        try {
            const meetingContext = await zoomSdk.getMeetingContext();
            meetingId = meetingContext.meetingID || null;
            console.log('Meeting ID:', meetingId);
        } catch (err) {
            console.warn('Could not get meeting context:', err.message);
        }

        const { runningContext } = configResponse;

        if (runningContext === 'inMeeting') {
            // SIDEBAR MODE
            const userContext = await zoomSdk.getUserContext();
            screenName = userContext.screenName || null;
            console.log('Screen name:', screenName);
            if (userContext.role === 'host') {
                try {
                    await zoomSdk.callZoomApi('startRTMS');
                } catch (rtmsErr) {
                    console.warn('Failed to start RTMS:', rtmsErr.message);
                }

                toggleButton.classList.remove('is-hidden');
                toggleButton.addEventListener('click', toggleImmersiveView);
                initializeChat();
            }
        } else if (runningContext === 'inImmersive') {
            // IMMERSIVE MODE
            mainContent.classList.add('is-hidden');
            immersiveContainer.classList.remove('is-hidden');

            // Initialize context toggle buttons
            initializeContextToggle();

            // Get and draw participants
            const response = await zoomSdk.getMeetingParticipants();
            participants = response.participants || [];
            console.log('Participants in immersive mode:', participants);
            await drawParticipants();

            // Start polling for speaker data
            startPolling();

            // Listen for participant changes
            zoomSdk.onParticipantChange(handleParticipantChange);

            // Handle resize
            window.addEventListener('resize', handleResize);
        }
    } catch (e) {
        console.error('Error initializing app:', e);
    }
})();

/**
 * Toggle immersive view from sidebar.
 */
async function toggleImmersiveView() {
    if (inImmersiveView) {
        try {
            await zoomSdk.closeRenderingContext();
            console.log('Closing immersive view - app will return to sidebar');
            // App will return to 'inMeeting' context
            inImmersiveView = false;
        } catch (error) {
            console.error('Failed to stop immersive view:', error);
        }
    } else {
        try {
            await zoomSdk.runRenderingContext({ view: 'immersive' });
            console.log('Starting immersive view - app will reload');
            // App will reload in 'inImmersive' context
            inImmersiveView = true;
        } catch (error) {
            console.error('Failed to start immersive view:', error);
        }
    }
}

/**
 * Draw participants in a row (up to 4 participants).
 */
async function drawParticipants() {
    // Clear existing participants first
    for (const p of participants) {
        try {
            await zoomSdk.clearParticipant({
                participantUUID: p.participantUUID,
            });
        } catch (error) {
            console.error(
                `Failed to clear participant ${p.screenName}:`,
                error
            );
        }
    }

    // Calculate positions for a horizontal row
    const width = window.innerWidth;
    const height = window.innerHeight;
    const quarterWidth = width / 2;

    // Define 4 positions in a row
    const positions = [
        { x: 0, y: 0 }, // Left
        { x: quarterWidth, y: 0 }, // Center-left
        { x: quarterWidth * 2, y: 0 }, // Center-right
        { x: quarterWidth * 3, y: 0 }, // Right
    ];

    // Draw up to 4 participants
    const displayParticipants = participants.slice(0, 4);
    for (let i = 0; i < displayParticipants.length; i++) {
        const participant = displayParticipants[i];
        const pos = positions[i];

        try {
            await zoomSdk.drawParticipant({
                participantUUID: participant.participantUUID,
                x: Math.round(pos.x),
                y: Math.round(pos.y),
                width: Math.round(quarterWidth),
                height: Math.round(height),
                zIndex: 1,
            });
            participantNames[i].textContent =
                participant.screenName || 'Unknown';
            console.log(
                `Drew participant: ${
                    participant.screenName || participant.participantUUID
                } at position ${i}`
            );
        } catch (error) {
            console.error(
                `Failed to draw participant ${participant.screenName}:`,
                error
            );
        }
    }
}

/**
 * Handle participant changes (join/leave)
 */
async function handleParticipantChange(event) {
    console.log('Participant change detected:', event);

    try {
        const response = await zoomSdk.getMeetingParticipants();
        const latest = response.participants || [];

        // Keep existing participants in their slots, append new ones
        const existingUUIDs = new Set(
            participants.map((p) => p.participantUUID)
        );
        const newParticipants = latest.filter(
            (p) => !existingUUIDs.has(p.participantUUID)
        );

        // Remove participants who left
        const latestUUIDs = new Set(latest.map((p) => p.participantUUID));
        participants = participants.filter((p) =>
            latestUUIDs.has(p.participantUUID)
        );

        // Append new ones at the end
        participants = [...participants, ...newParticipants];

        await drawParticipants();
    } catch (error) {
        console.error('Failed to handle participant change:', error);
    }
}

/**
 * Handle window resize
 */
async function handleResize() {
    console.log('Window resized, redrawing participants');
    await drawParticipants();
}

/**
 * Initialize chat interface
 */
function initializeChat() {
    if (!chatInput || !chatSubmit || !chatMessages) {
        console.error('Chat elements not found');
        return;
    }

    // Add click handler on submit button
    chatSubmit.addEventListener('click', handleChatSubmit);

    // Add enter key handler on input field
    chatInput.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') {
            handleChatSubmit();
        }
    });
}

/**
 * Handle chat message submission
 */
async function handleChatSubmit() {
    const message = chatInput.value.trim();

    // Don't submit empty messages
    if (!message || isChatProcessing) {
        return;
    }

    try {
        // Disable input/button
        isChatProcessing = true;
        chatInput.disabled = true;
        chatSubmit.disabled = true;

        // Add user message to UI immediately
        addMessageToUI(message, true);

        // Clear input field
        chatInput.value = '';

        // Send to backend with meetingId
        const response = await fetch('/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ message }),
        });

        const data = await response.json();

        if (data.success) {
            // Add agent response to UI
            addMessageToUI(data.response, false);
        } else {
            console.error('Chat error:', data.error);
            addMessageToUI(
                'Sorry, there was an error processing your message.',
                false
            );
        }
    } catch (error) {
        console.error('Failed to send chat message:', error);
        addMessageToUI(
            'Sorry, there was an error processing your message.',
            false
        );
    } finally {
        // Re-enable input/button
        isChatProcessing = false;
        chatInput.disabled = false;
        chatSubmit.disabled = false;
        chatInput.focus();
    }
}

/**
 * Add a message to the chat UI
 * @param {string} message - The message text
 * @param {boolean} isUser - True if message is from user, false if from agent
 */
function addMessageToUI(message, isUser) {
    // Create wrapper div
    const wrapper = document.createElement('div');
    wrapper.className = isUser
        ? 'message-wrapper user-message is-flex is-justify-content-flex-end'
        : 'message-wrapper agent-message';

    // Create box with message text
    const box = document.createElement('div');
    box.className = 'box';
    const paragraph = document.createElement('p');
    paragraph.textContent = message;
    box.appendChild(paragraph);

    // Append to wrapper and then to messages container
    wrapper.appendChild(box);
    chatMessages.appendChild(wrapper);

    // Auto-scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
}
