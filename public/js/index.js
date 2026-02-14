import zoomSdk from '@zoom/appssdk';

// State
let participants = [];

// Get components
const mainContent = document.getElementById('main');
const toggleButton = document.getElementById('toggle-view');
const immersiveContainer = document.getElementById('immersive');

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
                'onParticipantChange',
            ],
        });

        console.debug('Zoom JS SDK Configuration', configResponse);

        const { runningContext } = configResponse;

        if (runningContext === 'inMeeting') {
            // SIDEBAR MODE
            await zoomSdk.callZoomApi('startRTMS');

            const userContext = await zoomSdk.getUserContext();
            if (userContext.role === 'host') {
                toggleButton.classList.remove('hidden');
                toggleButton.addEventListener('click', startImmersiveView);
            }
        } else if (runningContext === 'inImmersive') {
            // IMMERSIVE MODE
            mainContent.classList.add('hidden');
            immersiveContainer.classList.remove('hidden');

            // Get and draw participants
            const response = await zoomSdk.getMeetingParticipants();
            participants = response.participants || [];
            console.log('Participants in immersive mode:', participants);
            await drawParticipants();

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
 * Start immersive view from sidebar
 */
async function startImmersiveView() {
    try {
        await zoomSdk.runRenderingContext({ view: 'immersive' });
        console.log('Starting immersive view - app will reload');
        // App will reload in 'inImmersive' context
    } catch (error) {
        console.error('Failed to start immersive view:', error);
    }
}

/**
 * Stop immersive view (optional - can be called from console or exit button)
 */
async function stopImmersiveView() {
    try {
        await zoomSdk.closeRenderingContext();
        console.log('Closing immersive view - app will return to sidebar');
        // App will return to 'inMeeting' context
    } catch (error) {
        console.error('Failed to stop immersive view:', error);
    }
}

/**
 * Draw participants in 2x2 grid (up to 4 participants)
 */
async function drawParticipants() {
    // Clear existing participants first
    for (const p of participants) {
        try {
            await zoomSdk.clearParticipant({ participantUUID: p.participantUUID });
        } catch (error) {
            console.error(`Failed to clear participant ${p.screenName}:`, error);
        }
    }

    // Calculate positions for 2x2 grid
    const width = window.innerWidth;
    const height = window.innerHeight;
    const halfWidth = width / 2;
    const halfHeight = height / 2;

    // Define 4 quadrant positions
    const positions = [
        { x: 0, y: 0 },                    // Top-left
        { x: halfWidth, y: 0 },            // Top-right
        { x: 0, y: halfHeight },           // Bottom-left
        { x: halfWidth, y: halfHeight }    // Bottom-right
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
                width: Math.round(halfWidth),
                height: Math.round(halfHeight),
                zIndex: 1
            });
            console.log(`Drew participant: ${participant.screenName || participant.participantUUID} at position ${i}`);
        } catch (error) {
            console.error(`Failed to draw participant ${participant.screenName}:`, error);
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
        participants = response.participants || [];
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
