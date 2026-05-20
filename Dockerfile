FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache xdg-utils glib
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
