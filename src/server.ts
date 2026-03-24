import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { app } from './app.js';
import { env } from './config/env.js';
import { connectDb } from './config/db.js';
import { seedData } from './config/seed.js';
import { setSocketServer } from './realtime.js';

const start = async () => {
  await connectDb();
  await seedData();

  const PORT = process.env.PORT || 3000;
  const httpServer = http.createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: env.corsOrigins.length ? env.corsOrigins : true,
      credentials: true
    }
  });

  io.on('connection', (socket) => {
    socket.emit('connected', { ok: true });
  });
  setSocketServer(io);

  httpServer.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
};

start().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});
