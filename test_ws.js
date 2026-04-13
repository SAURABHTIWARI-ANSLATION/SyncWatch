const WebSocket = require('ws');
const ws = new WebSocket('wss://syncwatch-o4za.onrender.com');

ws.on('open', () => {
  console.log('Connected');
  ws.send(JSON.stringify({ type: 'join', roomId: '01EA8499' }));
});

ws.on('message', (data) => {
  console.log('Received:', data.toString());
  setTimeout(() => process.exit(0), 1000);
});
