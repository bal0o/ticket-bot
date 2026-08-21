const crypto = require('crypto');
const discordApi = require('../utils/discordApi');

function createAuth({
	clientId,
	clientSecret,
	callbackUrl,
	scopes,
	getRoleFlags,
	computeAllowedTicketTypes,
	roleCacheTtlMs,
}) {
	function safeReturnTo(value) {
		if (!value || typeof value !== 'string') return null;
		if (!value.startsWith('/') || value.startsWith('//')) return null;
		if (value.startsWith('/login') || value.startsWith('/auth/')) return null;
		return value;
	}

	function rememberReturnTo(req, url) {
		const target = safeReturnTo(url);
		if (target) req.session.returnTo = target;
	}

	function ensureAuth(req, res, next) {
		if (req.session?.user) return next();
		rememberReturnTo(req, req.originalUrl);
		req.session.save((err) => {
			if (err) console.error('[web] failed to save returnTo before login', err);
			return res.redirect('/login');
		});
	}

	function attachUser(req, _res, next) {
		req.user = req.session?.user || null;
		req.isAuthenticated = () => !!req.user;
		next();
	}

	function registerRoutes(app) {
		app.get('/login', (req, res) => {
			if (req.query.returnTo) rememberReturnTo(req, String(req.query.returnTo));
			const state = crypto.randomBytes(16).toString('hex');
			req.session.oauthState = state;
			req.session.save((err) => {
				if (err) {
					console.error('[web] failed to save oauth state', err);
					return res.status(500).send('Login session error');
				}
				const url = discordApi.oauthAuthorizeUrl({
					clientId,
					redirectUri: callbackUrl,
					scopes,
					state,
				});
				return res.redirect(url);
			});
		});

		app.get('/auth/callback', async (req, res) => {
			try {
				const { code, state } = req.query;
				if (!code || !state || state !== req.session.oauthState) {
					return res.redirect('/auth/failure');
				}
				delete req.session.oauthState;

				const token = await discordApi.exchangeOauthCode({
					clientId,
					clientSecret,
					code: String(code),
					redirectUri: callbackUrl,
				});
				const profile = await discordApi.fetchOauthUser(token.access_token);
				req.session.user = {
					id: profile.id,
					username: profile.username,
					discriminator: profile.discriminator,
					avatar: profile.avatar,
				};

				const redirectTo = safeReturnTo(req.session.returnTo) || '/my';
				delete req.session.returnTo;

				setImmediate(async () => {
					try {
						const rf = await getRoleFlags(profile.id);
						computeAllowedTicketTypes(rf.roleIds);
					} catch (_) {}
				});

				req.session.save((err) => {
					if (err) {
						console.error('[web] failed to save session after login', err);
						return res.redirect('/auth/failure');
					}
					return res.redirect(redirectTo);
				});
			} catch (e) {
				console.error('[web] oauth callback failed', e?.data || e);
				return res.redirect('/auth/failure');
			}
		});

		app.get('/auth/failure', (_req, res) => {
			res.status(401).send('Discord authentication failed. Please verify your OAuth client settings and callback URL.');
		});

		app.get('/logout', (req, res) => {
			req.session.destroy(() => {
				res.redirect('/');
			});
		});
	}

	return {
		ensureAuth,
		attachUser,
		registerRoutes,
		rememberReturnTo,
		safeReturnTo,
		roleCacheTtlMs,
	};
}

module.exports = { createAuth };
