import express from 'express';
import { handleError, sanitize } from '../helpers/routing.js';
import { contextHeader, getAppContext } from '../helpers/cipher.js';
import { getInstallURL } from '../helpers/zoom-api.js';
import { handleUserChat } from '../helpers/agent-manager.js';

import session from '../session.js';

const router = express.Router();

/*
 * Home Page - Zoom App Launch handler
 * this route is used when a user navigates to the deep link
 */
function isContextExpired(context) {
    const currentTime = Date.now();
    return context.exp && context.exp < currentTime;
}

router.get('/', async (req, res, next) => {
    try {
        sanitize(req);

        const header = req.header(contextHeader);
        const context = header && getAppContext(header);

        if (!context) {
            return res.render('index', {
                isZoom: false,
                title: `Hello Browser`,
            });
        }

        // Check if the context is valid and not expired
        if (isContextExpired(context)) {
            return res
                .status(401)
                .json({ error: 'Invalid or expired context' });
        }

        return res.render('index', {
            isZoom: true,
            title: 'Context Assistant',
            chatHistory: [],
            chatTarget: 'Meeting',
        });
    } catch (e) {
        next(handleError(e));
    }
});

/*
 * Install Route - Install the Zoom App from the Zoom Marketplace
 * this route is used when a user installs the app from the Zoom Client
 */
router.get('/install', session, async (req, res) => {
    const { url, state, verifier } = getInstallURL();
    req.session.state = state;
    req.session.verifier = verifier;
    res.redirect(url.href);
});

/*
 * Chat Route - Handle chat messages via agent network
 */
router.post('/chat', async (req, res) => {
    try {
        sanitize(req);

        const { message, speakerName } = req.body;

        if (!message || typeof message !== 'string' || message.trim() === '') {
            return res
                .status(400)
                .json({ success: false, error: 'Message is required' });
        }

        if (!speakerName || typeof speakerName !== 'string') {
            return res
                .status(400)
                .json({ success: false, error: 'speakerName is required' });
        }

        const response = await handleUserChat(speakerName, message);
        return res.json({ success: true, response });
    } catch (e) {
        console.error('Chat error:', e.message);
        return res.json({
            success: false,
            error: e.message,
            response: `Sorry, I couldn't process that: ${e.message}`,
        });
    }
});

export default router;
