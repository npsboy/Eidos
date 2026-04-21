# Use a standard Node.js image
FROM node:20-bookworm-slim

RUN echo "THIS IS THE NEW DOCKERFILE"


# Set the working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Install Playwright browser dependencies (Chromium)
RUN npx playwright install --with-deps chromium

# Copy the rest of the application code
COPY . .

# Expose the API port
EXPOSE 8080

# Start the application
CMD ["node", "index.js"]