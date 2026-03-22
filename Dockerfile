FROM node:22-slim

WORKDIR /app
COPY server.js files.js skills.js ./
COPY skills/ ./skills/

ENV SKILLS_PATH=/app/skills

EXPOSE 3456

ENTRYPOINT ["node", "server.js"]
