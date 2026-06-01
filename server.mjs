import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import handler from './api/insights.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;

const server = http.createServer(async (req, res) => {
    // Enable CORS for development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/api/insights' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', async () => {
            try {
                const parsedBody = JSON.parse(body);
                // Create mock req and res compatible with Vercel's serverless function
                const mockReq = {
                    method: 'POST',
                    body: parsedBody
                };
                let status = 200;
                let responseHeaders = {};
                let responseBody = '';

                const mockRes = {
                    setHeader: (name, val) => {
                        responseHeaders[name] = val;
                        return mockRes;
                    },
                    status: (code) => {
                        status = code;
                        return mockRes;
                    },
                    json: (data) => {
                        responseHeaders['Content-Type'] = 'application/json';
                        responseBody = JSON.stringify(data);
                        return mockRes;
                    },
                    end: (data) => {
                        if (data) responseBody = data;
                        return mockRes;
                    }
                };

                await handler(mockReq, mockRes);

                res.writeHead(status, responseHeaders);
                res.end(responseBody);
            } catch (err) {
                console.error('[API Server Error]:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // Serve static files
    let pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    let filePath = path.join(__dirname, pathname);

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('File Not Found');
            } else {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end(`Internal Server Error: ${err.code}`);
            }
        } else {
            let contentType = 'text/html';
            if (filePath.endsWith('.js')) contentType = 'application/javascript';
            if (filePath.endsWith('.css')) contentType = 'text/css';
            if (filePath.endsWith('.png')) contentType = 'image/png';
            if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) contentType = 'image/jpeg';
            if (filePath.endsWith('.json')) contentType = 'application/json';

            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        }
    });
});

server.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 SolarRoots Local Dev Server started successfully!`);
    console.log(`🌐 Live Frontend: http://localhost:${PORT}`);
    console.log(`📡 Local Vision API: http://localhost:${PORT}/api/insights`);
    console.log(`======================================================\n`);
});
