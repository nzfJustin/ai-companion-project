FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source and build TypeScript
COPY . .
RUN npm run build

EXPOSE 3000
CMD ["node", "dist/index.js"]
