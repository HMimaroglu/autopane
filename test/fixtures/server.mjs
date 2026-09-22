// Local test site. Every form posts to /api/*, which records what was submitted so
// the e2e test can check the real outcome instead of trusting the agent's report.

import http from 'node:http';

const AIRLINES = ['Icelandair', 'PLAY', 'Delta', 'United', 'JetBlue', 'American', 'SAS', 'Lufthansa'];
export const FLIGHTS = Array.from({ length: 24 }, (_, i) => ({
  id: `F${100 + i}`,
  airline: AIRLINES[i % AIRLINES.length],
  departs: `${String(6 + (i % 14)).padStart(2, '0')}:${String(15 * (i % 4)).padStart(2, '0')}`,
  stops: [3, 11, 17].includes(i) ? 0 : 1 + (i % 2),
  price: i === 11 ? 164 : 180 + ((i * 37) % 420),
}));
export const CHEAPEST_NONSTOP = FLIGHTS.filter((f) => f.stops === 0).sort((a, b) => a.price - b.price)[0];

const shell = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px system-ui;max-width:720px;margin:40px auto;padding:0 16px}
li{display:flex;justify-content:space-between;align-items:center;padding:10px;border-bottom:1px solid #ddd}
input,select,button{font:inherit;padding:6px 10px;margin:4px 0}label{display:block;margin-top:10px}
nav a{margin-right:14px}</style></head><body>${body}</body></html>`;

const pages = {
  '/newsletter': () => shell('Newsletter signup', `<h1>Newsletter</h1>
    <label>Email address <input id="email" type="email"></label>
    <button id="sub" disabled>Subscribe</button><div id="msg"></div>
    <script>
      email.oninput = () => { sub.disabled = !email.value.includes('@'); };
      sub.onclick = async () => {
        await fetch('/api/subscribe', { method: 'POST', body: JSON.stringify({ email: email.value }) });
        msg.innerHTML = '<h2 role="status">Thanks, you are subscribed</h2>';
      };
    </script>`),

  '/flights': () => shell('Find flights', `<h1>Find flights</h1><form action="/flights/results">
    <label>From <select name="from"><option value="">Choose…</option><option>BOS</option><option>JFK</option><option>LAX</option></select></label>
    <label>To <select name="to"><option value="">Choose…</option><option>KEF</option><option>LHR</option><option>CDG</option></select></label>
    <label>Date <input name="date" placeholder="YYYY-MM-DD"></label>
    <button>Search flights</button></form>`),

  '/flights/results': (q) => shell('Flight results', `<h1>${q.get('from')} to ${q.get('to')}, ${q.get('date')}</h1><ul>${
    FLIGHTS.map((f) => `<li><span>${f.airline}, departs ${f.departs}, ${f.stops ? `${f.stops} stop` : 'Nonstop'}, $${f.price}</span>
      <a href="/flights/book?id=${f.id}"><button>Select</button></a></li>`).join('')}</ul>`),

  '/flights/book': (q) => {
    const f = FLIGHTS.find((x) => x.id === q.get('id'));
    return shell('Passenger details', `<h1>${f.airline} ${f.departs}, $${f.price}</h1>
      <form method="post" action="/api/book"><input type="hidden" name="id" value="${f.id}">
      <label>Passenger full name <input name="name"></label><button>Confirm booking</button></form>`);
  },

  '/login': () => shell('Sign in', `<h1>Sign in</h1><form method="post" action="/api/login">
    <label>Username <input name="user"></label><label>Password <input name="pass" type="password"></label>
    <button>Sign in</button></form>`),

  '/dashboard': () => shell('Dashboard', `<nav><a href="/dashboard">Overview</a><a href="/settings">Settings</a><a href="/login">Sign out</a></nav>
    <h1>Welcome back</h1><p>You have 3 new messages.</p>`),

  '/settings': () => shell('Settings', `<nav><a href="/dashboard">Overview</a><a href="/settings">Settings</a></nav>
    <h1>Settings</h1><form method="post" action="/api/settings">
    <label><input type="checkbox" name="notify"> Email notifications</label>
    <label><input type="checkbox" name="dark" checked> Dark mode</label>
    <button>Save settings</button></form>`),
};

export function startFixtures(port = 4317) {
  const records = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const data = req.headers['content-type']?.includes('form')
        ? Object.fromEntries(new URLSearchParams(body)) : JSON.parse(body || '{}');
      records.push({ path: url.pathname, data });
      if (url.pathname === '/api/book') {
        return send(res, shell('Booking confirmed', `<h1>Booking confirmed</h1><p>${data.name}, flight ${data.id}.</p>`));
      }
      if (url.pathname === '/api/login') {
        res.writeHead(303, { Location: '/dashboard' });
        return res.end();
      }
      if (url.pathname === '/api/settings') {
        return send(res, shell('Settings', `<h1>Settings saved</h1><p>Notifications ${data.notify ? 'on' : 'off'}.</p>`));
      }
      res.writeHead(204);
      return res.end();
    }
    const page = pages[url.pathname];
    if (!page) {
      res.writeHead(404);
      return res.end('not found');
    }
    send(res, page(url.searchParams));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, records, url: `http://127.0.0.1:${port}` })));
}

function send(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
