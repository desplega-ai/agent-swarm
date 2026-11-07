#!/bin/sh
# Only SSH, HTTP and HTTPS. The swarm publishes its ports on 127.0.0.1, because
# Docker-published ports bypass ufw.
ufw limit ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp

ufw --force enable
