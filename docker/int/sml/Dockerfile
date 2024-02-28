from phusion/baseimage:jammy-1.0.1

ENV LC_CTYPE=C.UTF-8
ENV DEBIAN_FRONTEND=noninteractive


#comment out all of the source repos, makes apt-get update considerably faster
RUN  sed -i 's/deb-src/#deb-src/g' /etc/apt/sources.list

#install [minimal] dependencies:
RUN apt-get update && \
    apt-get install -yq build-essential aptitude apt-rdepends \
      software-properties-common ca-certificates rsync \
      apt-transport-https less vim psmisc zip unzip wget curl \
      curl git grep iputils-ping net-tools sudo dnsutils tcptrack && \
    rm -rf /var/lib/apt/lists

ENV TERM xterm-256color

##install node
RUN sudo apt-get update && \
    sudo apt-get install -y curl gnupg && \
    sudo mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list

RUN apt-get update && apt-get install -yq nodejs

##install postgresql-client
RUN apt-get update && apt-get install -yq postgresql-client

