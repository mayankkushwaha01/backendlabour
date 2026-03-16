import { app } from './app.js';
import { env } from './config/env.js';
import { connectDb } from './config/db.js';
import { seedData } from './config/seed.js';

const start = async () => {
  await connectDb();
  await seedData();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
};

start().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});
