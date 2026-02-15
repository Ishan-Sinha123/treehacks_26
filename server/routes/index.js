import express from 'express';
import { handleError, sanitize } from '../helpers/routing.js';
import { contextHeader, getAppContext } from '../helpers/cipher.js';
import { getInstallURL } from '../helpers/zoom-api.js';
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
            participantContexts: {
                user1: 'Wants to build an app with LLMs. Unsure how to get started.',
                user2: 'Knows a bit about LLMs, but is concerned about data privacy and security.',
                user3: "Isn't sure if they want to use LLMs in their app, but is interested in learning more about the possibilities.",
                user4: 'Has experience with traditional software but wants to explore how AI can enhance their products.',
            },
            conversationTimeline: [
                'Topic A',
                'Another topic',
                'Something else',
                'Topic A',
                'Yet another thing',
                'More concepts about things',
                'Something else',
                'Topic A',
                'Topic A',
                'Another topic',
                'Something else',
                'Topic A',
                'Yet another thing',
                'More concepts about things',
                'Something else',
                'Another topic',
                'Something else',
                'Topic A',
                'Yet another thing',
                'More concepts about things',
                'Something else',
            ],
            chatHistory: [
                'What did Kenneth say about AI?',
                'Kenneth said that AI is a powerful tool that can be used to enhance our products, but we need to be careful about data privacy and security.',
                'Why did Kenneth say that?',
                'Kenneth is concerned about data privacy and security because LLMs often require large amounts of data to train, and there is a risk that sensitive information could be exposed if not handled properly.',
                'What are some ways we can mitigate those risks?',
                'We can mitigate those risks by implementing strong data encryption, using anonymized data for training, and ensuring that we have robust access controls in place.',
            ],
            chatTarget: 'user1',
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
 * Chat Route - Handle chat messages
 */
router.post('/chat', async (req, res, next) => {
    try {
        sanitize(req);

        const { message } = req.body;

        // Validate message
        if (!message || typeof message !== 'string' || message.trim() === '') {
            return res
                .status(400)
                .json({ success: false, error: 'Message is required' });
        }

        // Placeholder response (future: integrate LLM/logic)
        const response = `You said: "${message}". This is a placeholder response.`;

        return res.json({ success: true, response });
    } catch (e) {
        next(handleError(e));
    }
});

export default router;
