# Toolchain for building and proving the local-only fork. Not part of the shipped artifact.
FROM node@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates git bubblewrap strace nftables tcpdump iproute2 \
		ripgrep fd-find curl netcat-openbsd \
	&& ln -s /usr/bin/fdfind /usr/local/bin/fd \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /src
