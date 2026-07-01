{{/*
Expand the name of the chart.
*/}}
{{- define "agent-swarm.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "agent-swarm.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart name and version as used by the chart label.
*/}}
{{- define "agent-swarm.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "agent-swarm.labels" -}}
helm.sh/chart: {{ include "agent-swarm.chart" . }}
{{ include "agent-swarm.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "agent-swarm.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agent-swarm.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
ServiceAccount name.
*/}}
{{- define "agent-swarm.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "agent-swarm.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the credentials Secret. Returns auth.existingSecret if set, otherwise
the chart-created Secret name.
*/}}
{{- define "agent-swarm.authSecretName" -}}
{{- if .Values.auth.existingSecret }}
{{- .Values.auth.existingSecret }}
{{- else }}
{{- printf "%s-auth" (include "agent-swarm.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Name of the litestream credentials Secret.
*/}}
{{- define "agent-swarm.litestreamSecretName" -}}
{{- if .Values.litestream.s3.existingSecret }}
{{- .Values.litestream.s3.existingSecret }}
{{- else }}
{{- printf "%s-litestream-s3" (include "agent-swarm.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Name of the agent-fs S3 credentials Secret.
*/}}
{{- define "agent-swarm.agentFsSecretName" -}}
{{- if .Values.agentFs.s3.existingSecret }}
{{- .Values.agentFs.s3.existingSecret }}
{{- else }}
{{- printf "%s-agent-fs-s3" (include "agent-swarm.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Server image reference. Tag defaults to .Chart.AppVersion when unset.
*/}}
{{- define "agent-swarm.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- printf "%s/%s:%s" .Values.image.registry .Values.image.repository $tag -}}
{{- end }}

{{/*
Worker image reference. Tag defaults to .Chart.AppVersion when unset.
*/}}
{{- define "agent-swarm.workerImage" -}}
{{- $tag := default .Chart.AppVersion .Values.workerImage.tag -}}
{{- printf "%s/%s:%s" .Values.workerImage.registry .Values.workerImage.repository $tag -}}
{{- end }}

{{/*
Common env vars for every pool pod.
*/}}
{{- define "agent-swarm.poolEnv" -}}
- name: MCP_BASE_URL
  value: "http://{{ include "agent-swarm.fullname" . }}-api:{{ .Values.api.port }}"
- name: YOLO
  value: {{ .Values.poolDefaults.yolo | quote }}
{{- if .Values.agentFs.enabled }}
- name: AGENT_FS_API_URL
  value: "http://{{ include "agent-swarm.fullname" . }}-agent-fs:{{ .Values.agentFs.port }}"
{{- end }}
{{- end }}

{{/*
Volumes shared by every pool pod. Pass a dict {root, pool} so per-pool
emptyDir overrides resolve. Handles sharedVolume.existingClaim for an
RWX cross-pod /workspace/shared.
*/}}
{{- define "agent-swarm.poolVolumes" -}}
{{- $root := .root -}}
{{- $pool := .pool -}}
{{- $shared := default $root.Values.poolDefaults.emptyDir.sharedSizeLimit (($pool.emptyDir).sharedSizeLimit) -}}
{{- $logs := default $root.Values.poolDefaults.emptyDir.logsSizeLimit (($pool.emptyDir).logsSizeLimit) -}}
{{- if $root.Values.sharedVolume.existingClaim }}
- name: shared
  persistentVolumeClaim:
    claimName: {{ $root.Values.sharedVolume.existingClaim }}
{{- else }}
- name: shared
  emptyDir:
    sizeLimit: {{ $shared }}
{{- end }}
- name: logs
  emptyDir:
    sizeLimit: {{ $logs }}
{{- end }}

{{/*
Volume mounts shared by every pool pod.
*/}}
{{- define "agent-swarm.poolVolumeMounts" -}}
- name: personal
  mountPath: /workspace/personal
- name: shared
  mountPath: /workspace/shared
- name: logs
  mountPath: /logs
{{- end }}

{{/*
Init container that waits for the API to become healthy before starting
the pool pod. Avoids bootstrap thrash when a fresh install rolls all pods
in parallel. Capped at 60 retries × 5s = 5 min so a misconfigured install
doesn't pin pool pods in Init forever.
*/}}
{{- define "agent-swarm.waitForApi" -}}
- name: wait-for-api
  image: busybox:1.36
  command:
    - sh
    - -c
    - |
      i=0
      while [ $i -lt 60 ]; do
        if wget -qO- http://{{ include "agent-swarm.fullname" . }}-api:{{ .Values.api.port }}{{ .Values.api.healthCheck.path }} >/dev/null 2>&1; then
          echo "API is up"
          exit 0
        fi
        i=$((i + 1))
        echo "Waiting for API (attempt $i/60)..."
        sleep 5
      done
      echo "API never came up after 5 minutes; check the API pod"
      exit 1
{{- end }}
