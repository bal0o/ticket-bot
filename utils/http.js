async function request(url, options = {}) {
	const {
		method = 'GET',
		headers = {},
		body,
		timeout = 10000,
		json = true,
	} = options;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeout);

	try {
		const init = {
			method,
			headers: { ...headers },
			signal: controller.signal,
		};

		if (body !== undefined) {
			if (typeof body === 'string' || Buffer.isBuffer(body)) {
				init.body = body;
			} else {
				init.body = JSON.stringify(body);
				if (!init.headers['Content-Type'] && !init.headers['content-type']) {
					init.headers['Content-Type'] = 'application/json';
				}
			}
		}

		const res = await fetch(url, init);
		const contentType = res.headers.get('content-type') || '';
		let data = null;

		if (json && contentType.includes('application/json')) {
			data = await res.json().catch(() => null);
		} else {
			data = await res.text().catch(() => '');
			if (json && typeof data === 'string') {
				try {
					data = JSON.parse(data);
				} catch (_) {}
			}
		}

		return {
			ok: res.ok,
			status: res.status,
			statusText: res.statusText,
			headers: res.headers,
			data,
			raw: data,
		};
	} finally {
		clearTimeout(timer);
	}
}

function get(url, options = {}) {
	return request(url, { ...options, method: 'GET' });
}

function post(url, body, options = {}) {
	return request(url, { ...options, method: 'POST', body });
}

module.exports = { request, get, post };
