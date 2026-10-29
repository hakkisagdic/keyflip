FROM node:20-alpine

# git: keyflip's state repo · sqlite: chat/cookie stores · bash: helper shells
RUN apk add --no-cache git sqlite bash

WORKDIR /keyflip

# The build context is the REPO ROOT (see docker-compose.yml), so these paths are repo-relative.
# keyflip has ZERO runtime dependencies — package.json + source are all the image needs.
COPY package.json ./
COPY bin ./bin
COPY src ./src

# node:20-alpine already ships a UID/GID 1000 ("node"), so the simulation user gets 10001.
# run-simulation.sh chowns the shared volume to this user before the first `docker exec`.
RUN addgroup -g 10001 keyflip \
 && adduser -u 10001 -G keyflip -s /bin/sh -D keyflip \
 && mkdir -p /home/keyflip \
 && chown -R keyflip:keyflip /keyflip /home/keyflip

USER keyflip
ENV HOME=/home/keyflip

# Containers stay alive so run-simulation.sh can drive each step with `docker exec` and assert on
# real command output (a startup script would bury failures inside the container log).
CMD ["sleep", "infinity"]
