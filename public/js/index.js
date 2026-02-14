import zoomSdk from '@zoom/appssdk';

// State management.
let isImmersiveActive = false;
let participants = [];
let canvasContext = null;

// Get components.
const content = document.getElementById('main');
const toggleButton = document.getElementById('toggle-view');
const canvas = document.getElementById('immersive-canvas');
const ctx = canvas.getContext('2d');

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
                'sendAppInvitationToAllParticipants',
                'onSendAppInvitation',
                'onParticipantChange',
            ],
        });

        console.debug('Zoom JS SDK Configuration', configResponse);

        const { runningContext } = configResponse;
        if (runningContext === 'inMeeting') {
            await zoomSdk.callZoomApi('startRTMS');

            // Check user role and setup immersive view for host
            const userContext = await zoomSdk.getUserContext();
            const { role } = userContext;

            // Show the toggle button for the host.
            if (role === 'host') {
                toggleButton.classList.remove('hidden');
            }
        }
    } catch (e) {
        console.error(e);
    }
})();

/**
 * Setup immersive view controls and event listeners (host only)
 */
function setupImmersiveView() {
    const toggleButton = document.getElementById('toggle-immersive');
    const canvas = document.getElementById('immersive-canvas');

    if (!toggleButton || !canvas) {
        console.error('Required elements not found');
        return;
    }

    // Setup button click handler
    toggleButton.addEventListener('click', handleToggleImmersive);

    // Listen for participant changes
    zoomSdk.onParticipantChange(handleParticipantChange);

    // Handle window resize
    window.addEventListener('resize', () => {
        if (isImmersiveActive) {
            setupCanvas();
            drawParticipants();
        }
    });
}

/**
 * Toggle immersive view on/off
 */
async function handleToggleImmersive() {
    const toggleButton = document.getElementById('toggle-immersive');
    toggleButton.disabled = true;

    try {
        if (isImmersiveActive) {
            await stopImmersiveView();
        } else {
            await startImmersiveView();
        }
    } catch (error) {
        console.error('Error toggling immersive view:', error);
        showError(error.message || 'Failed to toggle immersive view');
    } finally {
        toggleButton.disabled = false;
    }
}

/**
 * Start immersive view mode
 */
async function startImmersiveView() {
    try {
        // Start rendering context
        await zoomSdk.runRenderingContext({ view: 'immersive' });
        console.log('Rendering context started');

        // Get meeting participants
        const participantsResponse = await zoomSdk.getMeetingParticipants();
        participants = participantsResponse.participants || [];
        console.log('Participants:', participants);

        // Setup canvas
        setupCanvas();

        // Draw participants
        drawParticipants();

        // Send invitations to all participants
        try {
            const invitationResponse =
                await zoomSdk.sendAppInvitationToAllParticipants();
            console.log('Invitation sent:', invitationResponse.invitationUUID);
        } catch (inviteError) {
            console.warn('Could not send invitations:', inviteError);
            // Don't fail the whole operation if invitations fail
        }

        // Update UI state
        isImmersiveActive = true;
        const toggleButton = document.getElementById('toggle-immersive');
        const canvas = document.getElementById('immersive-canvas');

        toggleButton.textContent = 'Stop Immersive View';
        toggleButton.classList.add('active');
        canvas.style.display = 'block';
        document.body.classList.add('immersive-active');
    } catch (error) {
        console.error('Failed to start immersive view:', error);
        throw error;
    }
}

/**
 * Stop immersive view mode
 */
async function stopImmersiveView() {
    try {
        // Clear all participants
        await clearAllParticipants();

        // Close rendering context
        await zoomSdk.closeRenderingContext();
        console.log('Rendering context closed');

        // Update UI state
        isImmersiveActive = false;
        const toggleButton = document.getElementById('toggle-immersive');
        const canvas = document.getElementById('immersive-canvas');

        toggleButton.textContent = 'Start Immersive View';
        toggleButton.classList.remove('active');
        canvas.style.display = 'none';
        document.body.classList.remove('immersive-active');

        participants = [];
    } catch (error) {
        console.error('Failed to stop immersive view:', error);
        throw error;
    }
}

/**
 * Setup canvas with proper dimensions and device pixel ratio
 */
function setupCanvas() {
    const canvas = document.getElementById('immersive-canvas');
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;

    canvasContext = canvas.getContext('2d');
    if (canvasContext) {
        canvasContext.scale(dpr, dpr);
    }
}

/**
 * Draw participants in a centered grid layout
 */
async function drawParticipants() {
    if (!participants || participants.length === 0) {
        console.log('No participants to draw');
        return;
    }

    // Clear existing participants first
    await clearAllParticipants();

    // Layout configuration
    const squareSize = 400;
    const participantSize = 120;
    const spacing = 10;
    const participantWithSpacing = participantSize + spacing;

    // Calculate grid dimensions
    const cols = Math.ceil(Math.sqrt(participants.length));
    // const rows = Math.ceil(participants.length / cols);

    // Calculate centered position
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const startX = (viewportWidth - squareSize) / 2;
    const startY = (viewportHeight - squareSize) / 2;

    // Draw each participant
    for (let i = 0; i < participants.length; i++) {
        const participant = participants[i];
        const col = i % cols;
        const row = Math.floor(i / cols);

        const x = startX + col * participantWithSpacing;
        const y = startY + row * participantWithSpacing;

        try {
            await zoomSdk.drawParticipant({
                participantUUID: participant.participantUUID,
                x: Math.round(x),
                y: Math.round(y),
                width: participantSize,
                height: participantSize,
                zIndex: 1,
            });
            console.log(
                `Drew participant: ${
                    participant.screenName || participant.participantUUID
                }`
            );
        } catch (error) {
            console.error(
                `Failed to draw participant ${participant.screenName}:`,
                error
            );
            // Continue with other participants
        }
    }
}

/**
 * Clear all drawn participants
 */
async function clearAllParticipants() {
    for (const participant of participants) {
        try {
            await zoomSdk.clearParticipant({
                participantUUID: participant.participantUUID,
            });
        } catch (error) {
            console.error(
                `Failed to clear participant ${participant.screenName}:`,
                error
            );
        }
    }
}

/**
 * Handle participant changes (join/leave)
 */
async function handleParticipantChange(event) {
    if (!isImmersiveActive) return;

    console.log('Participant change detected:', event);

    try {
        // Re-fetch participant list
        const participantsResponse = await zoomSdk.getMeetingParticipants();
        participants = participantsResponse.participants || [];

        // Redraw participants with new layout
        await drawParticipants();
    } catch (error) {
        console.error('Failed to handle participant change:', error);
    }
}

/**
 * Show error notification to user
 */
function showError(message) {
    const errorDiv = document.createElement('div');
    errorDiv.textContent = message;
    errorDiv.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background-color: #f44336;
        color: white;
        padding: 16px;
        border-radius: 4px;
        z-index: 10000;
        max-width: 300px;
    `;

    document.body.appendChild(errorDiv);

    setTimeout(() => {
        errorDiv.remove();
    }, 5000);
}
