FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --include=dev

COPY . .

RUN npx prisma generate

EXPOSE 8080

CMD ["sh", "-c", "npx prisma db push && npx tsx src/server.ts"]