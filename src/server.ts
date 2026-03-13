import { app } from './app.js';
import { env } from './config/env.js';
import { connectDb } from './config/db.js';
import { seedData } from './config/seed.js';

const start = async () => {
  await connectDb();
  await seedData();

  app.listen(env.port, () => {
    console.log(`API running on http://localhost:${env.port}`);
  });
};

start().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});
