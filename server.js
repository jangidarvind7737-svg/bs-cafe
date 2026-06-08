const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function ensureDataStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const fileName of ['orders.json', 'messages.json']) {
    const file = path.join(DATA_DIR, fileName);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, '[]\n', 'utf8');
    }
  }
}

function send(res, status, body, headers = JSON_HEADERS) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload, null, 2), JSON_HEADERS);
}

function readJsonFile(fileName, fallback) {
  try {
    const fullPath = path.join(DATA_DIR, fileName);
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch (error) {
    return fallback;
  }
}

function writeJsonFile(fileName, value) {
  fs.writeFileSync(path.join(DATA_DIR, fileName), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error('Request body is too large.'));
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error('Invalid JSON body.'));
      }
    });
  });
}

function requiredString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function cleanText(value) {
  return String(value || '').trim().slice(0, 500);
}

function calculateOrder(items, menuItems) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Add at least one item to place an order.');
  }

  const menuById = new Map(menuItems.map((item) => [Number(item.id), item]));
  const normalizedItems = items.map((item) => {
    const id = Number(item.id);
    const quantity = Number(item.quantity);
    const menuItem = menuById.get(id);

    if (!menuItem || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      throw new Error('One or more order items are invalid.');
    }

    return {
      id,
      name: menuItem.name,
      price: menuItem.price,
      quantity,
      subtotal: menuItem.price * quantity,
    };
  });

  const total = normalizedItems.reduce((sum, item) => sum + item.subtotal, 0);
  return { items: normalizedItems, total };
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/menu') {
    sendJson(res, 200, readJsonFile('menu.json', []));
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/reviews') {
    sendJson(res, 200, readJsonFile('reviews.json', []));
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/gallery') {
    sendJson(res, 200, readJsonFile('gallery.json', []));
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/orders') {
    sendJson(res, 200, readJsonFile('orders.json', []));
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/orders') {
    try {
      const payload = await parseBody(req);
      if (!requiredString(payload.name) || !requiredString(payload.phone)) {
        sendJson(res, 400, { error: 'Name and phone are required.' });
        return true;
      }

      const menuItems = readJsonFile('menu.json', []);
      const orderPricing = calculateOrder(payload.items, menuItems);
      const orders = readJsonFile('orders.json', []);
      const order = {
        id: `ORD-${Date.now()}`,
        name: cleanText(payload.name),
        phone: cleanText(payload.phone),
        address: cleanText(payload.address),
        notes: cleanText(payload.notes),
        status: 'received',
        createdAt: new Date().toISOString(),
        ...orderPricing,
      };

      orders.unshift(order);
      writeJsonFile('orders.json', orders);
      sendJson(res, 201, { message: 'Order received.', order });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/contact') {
    try {
      const payload = await parseBody(req);
      if (!requiredString(payload.name) || !requiredString(payload.phone)) {
        sendJson(res, 400, { error: 'Name and phone are required.' });
        return true;
      }

      const messages = readJsonFile('messages.json', []);
      const message = {
        id: `MSG-${Date.now()}`,
        name: cleanText(payload.name),
        phone: cleanText(payload.phone),
        message: cleanText(payload.message),
        createdAt: new Date().toISOString(),
      };

      messages.unshift(message);
      writeJsonFile('messages.json', messages);
      sendJson(res, 201, { message: 'Thanks! We will get back to you soon.', entry: message });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'API route not found.' });
    return true;
  }

  return false;
}

function serveStatic(req, res, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const safePath = path.normalize(decodeURIComponent(requestedPath)).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(ROOT, safePath);

  if (!filePath.startsWith(ROOT)) {
    send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, content, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
  });
}

ensureDataStore();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const handled = await handleApi(req, res, url.pathname);
  if (!handled) {
    serveStatic(req, res, url.pathname);
  }
});

server.listen(PORT, () => {
  console.log(`Bromo Momos server running at http://localhost:${PORT}`);
});
