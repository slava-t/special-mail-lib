#!/usr/bin/env bash
set -eu -o pipefail
script_dir="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
docker_dir="$script_dir/../../docker/int"
trap "bash -c 'cd \"$docker_dir\" && docker-compose down'" EXIT

cd "$docker_dir"

#run the cluster
export USER_NID=$(id -nu)
export USER_UID=$(id -u)
export USER_GID=$(id -g)
docker-compose up --build -d

sleep 5

docker-compose exec sml bash -c 'cd /sml && npm ci && npm run all-tests'





