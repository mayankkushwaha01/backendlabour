import type { Server as SocketIOServer } from 'socket.io';

let io: SocketIOServer | null = null;

export const setSocketServer = (server: SocketIOServer) => {
  io = server;
};

export const getSocketServer = () => io;

export const emitWorkersUpdated = () => {
  io?.emit('workersUpdated', { at: new Date().toISOString() });
};
