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

export default router;
