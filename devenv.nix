{
  pkgs,
  ...
}:

{
  # https://devenv.sh/packages/
  packages = [
    pkgs.git
    pkgs.bun
    pkgs.nodejs
    pkgs.pnpm
  ];

  # Install portless (not in nixpkgs) via npm on first shell entry
  enterShell = ''
    export PNPM_HOME="$DEVENV_ROOT/.pnpm-global"
    export PATH="$PNPM_HOME:$PATH"
    if [ ! -x "$PNPM_HOME/portless" ]; then
      echo "Installing portless..."
      pnpm add -g portless
    fi
  '';

  # https://devenv.sh/languages/
  languages.javascript = {
    bun = {
      enable = true;
      install.enable = true;
    };
  };

  # https://devenv.sh/processes/
  env.PNPM_HOME = "$DEVENV_ROOT/.pnpm-global";
  env.PATH = "$DEVENV_ROOT/.pnpm-global:$PATH";

  # https://devenv.sh/tasks/
  tasks."docker:build" = {
    exec = "docker build -f Dockerfile.worker -t agent-swarm-worker:latest .";
    before = [ "devenv:processes:lead" "devenv:processes:worker" ];
  };

  processes = {
    api = {
      exec = "bun run start:http";
      ready.http.get = { port = 3013; path = "/health"; };
    };
    ui.exec = "cd new-ui && pnpm install && pnpm exec vite";
    lead = {
      exec = "docker run --rm --name devenv-lead --env-file .env.docker-lead -e AGENT_ROLE=lead -p 3201:3000 -v ./logs:/logs -v ./work/shared:/workspace/shared -v ./work/lead:/workspace/personal agent-swarm-worker:latest";
      after = [ "devenv:processes:api" ];
    };
    worker = {
      exec = "docker run --rm --name devenv-worker --env-file .env.docker -p 3202:3000 -v ./logs:/logs -v ./work/shared:/workspace/shared -v ./work/worker-1:/workspace/personal agent-swarm-worker:latest";
      after = [ "devenv:processes:api" ];
    };
    inspector.exec = "bun run inspector:http";
  };

}
