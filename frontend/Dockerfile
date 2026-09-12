FROM node:22-slim

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV COPILOTKIT_TELEMETRY_DISABLED=true

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV PORT=3001
ENV NODE_ENV=production
EXPOSE 3001

USER node
CMD ["npm", "start"]
