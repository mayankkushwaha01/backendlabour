FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN npx prisma generate

EXPOSE 5000

# prisma db push deploy time pe hoga, build time pe nahi
CMD ["sh", "-c", "npx prisma db push && npm start"]
