module.exports = (request, response) => {
    const siteKey = process.env.RECAPTCHA_ENTERPRISE_SITE_KEY || '';
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    response.status(200).send(`window.__FIREBASE_APPCHECK_SITE_KEY__ = ${JSON.stringify(siteKey)};`);
};