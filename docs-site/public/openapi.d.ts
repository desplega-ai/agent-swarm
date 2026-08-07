export interface paths {
    "/api/active-sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List active sessions */
        get: {
            parameters: {
                query?: {
                    agentId?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Active session list */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            sessions: components["schemas"]["ActiveSession"][];
                        };
                    };
                };
            };
        };
        put?: never;
        /** Create a new active session */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        agentId: string;
                        taskId?: string;
                        triggerType: string;
                        inboxMessageId?: string;
                        taskDescription?: string;
                        runnerSessionId?: string;
                    };
                };
            };
            responses: {
                /** @description Session created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            session: components["schemas"]["ActiveSession"];
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/active-sessions/by-task/{taskId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete active session by task ID */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    taskId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Session deleted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            deleted: boolean;
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/active-sessions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete active session by ID */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Session deleted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            deleted: boolean;
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/active-sessions/heartbeat/{taskId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Update heartbeat for an active session */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    taskId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Heartbeat updated */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            updated: boolean;
                        };
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/active-sessions/provider-session/{taskId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Update provider session ID on an active session */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    taskId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        providerSessionId: string;
                    };
                };
            };
            responses: {
                /** @description Provider session ID updated */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            updated: boolean;
                        };
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/active-sessions/cleanup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Clean up stale sessions */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        agentId?: string;
                        maxAgeMinutes?: number;
                    };
                };
            };
            responses: {
                /** @description Cleanup result */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            cleaned: number;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/active-sessions/recover-orphaned-tasks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Recover orphaned in-progress tasks for an agent */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        agentId: string;
                        minAgeSeconds?: number;
                    };
                };
            };
            responses: {
                /** @description Recovery result */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            recovered: number;
                            tasks: components["schemas"]["AgentTask"][];
                        };
                    };
                };
                /** @description Can only recover orphaned tasks for the calling agent */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apps/{id}/user-config": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get app user configuration
         * @description Returns the current definition schema and this principal's tolerantly merged values.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Merged user configuration */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            values: {
                                [key: string]: string | number | boolean | null;
                            };
                            schema: {
                                [key: string]: {
                                    /** @enum {string} */
                                    kind: "string" | "number" | "boolean" | "date" | "enum";
                                    default?: string | number | boolean;
                                    enum?: string[];
                                    label?: string;
                                };
                            };
                        };
                    };
                };
                /** @description Permission denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description App not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description App definition needs repair */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        /**
         * Set app user configuration
         * @description Stores validated per-user values outside the versioned app definition. The reserved `$theme` key (a preset-theme slug) is accepted on every app, even one that declares no userConfig schema.
         */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        values: {
                            [key: string]: unknown;
                        };
                    };
                };
            };
            responses: {
                /** @description Stored user configuration */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            values: {
                                [key: string]: string | number | boolean | null;
                            };
                            schema: {
                                [key: string]: {
                                    /** @enum {string} */
                                    kind: "string" | "number" | "boolean" | "date" | "enum";
                                    default?: string | number | boolean;
                                    enum?: string[];
                                    label?: string;
                                };
                            };
                        };
                    };
                };
                /** @description Invalid user configuration */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Permission denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description App not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description App definition needs repair */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Request exceeds 64 KB or serialized values exceed 16 KB */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apps": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List apps */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description App summaries without definitions */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            apps: {
                                id: string;
                                name: string;
                                description?: string;
                                createdAt: string;
                                updatedAt: string;
                            }[];
                        };
                    };
                };
            };
        };
        put?: never;
        /** Create an app */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        name: string;
                        description?: string;
                        definition?: unknown;
                        forceElementBreak?: string[];
                    };
                };
            };
            responses: {
                /** @description Created app */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            app: {
                                id: string;
                                name: string;
                                description?: string;
                                definition: {
                                    [key: string]: unknown;
                                } | unknown[] | string | number | boolean | null;
                                definitionError?: {
                                    path: string;
                                    message: string;
                                }[];
                                createdAt: string;
                                updatedAt: string;
                            };
                        };
                    };
                };
                /** @description Invalid app definition */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Permission denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apps/{id}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List app definition versions */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description App definition versions */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            versions: {
                                id: string;
                                appId: string;
                                version: number;
                                snapshot?: unknown;
                                changedByAgentId?: string;
                                createdAt: string;
                            }[];
                        };
                    };
                };
                /** @description App not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apps/{id}/versions/{version}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get an app definition version */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    version: number;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description App definition version */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            version: {
                                id: string;
                                appId: string;
                                version: number;
                                snapshot?: unknown;
                                changedByAgentId?: string;
                                createdAt: string;
                            };
                        };
                    };
                };
                /** @description App or version not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apps/{id}/rollback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Rollback an app definition
         * @description Restores a snapshot through the ordinary schema migration engine. Lossy restores require migration directives.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        version: number;
                        migration?: {
                            [key: string]: {
                                set: string | number | boolean;
                            } | {
                                from: string;
                                map?: {
                                    [key: string]: string | number | boolean;
                                };
                                else?: string | number | boolean | null;
                            } | {
                                /** @enum {boolean} */
                                coerce: true;
                                else?: string | number | boolean | null;
                            } | {
                                /** @enum {boolean} */
                                purge: true;
                            };
                        };
                        forceElementBreak?: string[];
                    };
                };
            };
            responses: {
                /** @description Rolled back app */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            app: {
                                id: string;
                                name: string;
                                description?: string;
                                definition: {
                                    [key: string]: unknown;
                                } | unknown[] | string | number | boolean | null;
                                definitionError?: {
                                    path: string;
                                    message: string;
                                }[];
                                createdAt: string;
                                updatedAt: string;
                            };
                            migration: {
                                scanned: number;
                                backfilled: number;
                                coerced: number;
                                mapped: number;
                                elsed: number;
                                purgedValues: number;
                                idxRebuilt: number;
                                orphanFields: string[];
                                userConfigChanged: string[];
                            };
                        };
                    };
                };
                /** @description Invalid rollback definition or schema migration */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Permission denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description App or app version not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apps/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get an app */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description App including its definition */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            app: {
                                id: string;
                                name: string;
                                description?: string;
                                definition: {
                                    [key: string]: unknown;
                                } | unknown[] | string | number | boolean | null;
                                definitionError?: {
                                    path: string;
                                    message: string;
                                }[];
                                createdAt: string;
                                updatedAt: string;
                            };
                        };
                    };
                };
                /** @description Permission denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description App not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        /** Update an app */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        name?: string;
                        description?: string;
                        definition?: unknown;
                        migration?: {
                            [key: string]: {
                                set: string | number | boolean;
                            } | {
                                from: string;
                                map?: {
                                    [key: string]: string | number | boolean;
                                };
                                else?: string | number | boolean | null;
                            } | {
                                /** @enum {boolean} */
                                coerce: true;
                                else?: string | number | boolean | null;
                            } | {
                                /** @enum {boolean} */
                                purge: true;
                            };
                        };
                        forceElementBreak?: string[];
                    };
                };
            };
            responses: {
                /** @description Updated app */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            app: {
                                id: string;
                                name: string;
                                description?: string;
                                definition: {
                                    [key: string]: unknown;
                                } | unknown[] | string | number | boolean | null;
                                definitionError?: {
                                    path: string;
                                    message: string;
                                }[];
                                createdAt: string;
                                updatedAt: string;
                            };
                            migration: {
                                scanned: number;
                                backfilled: number;
                                coerced: number;
                                mapped: number;
                                elsed: number;
                                purgedValues: number;
                                idxRebuilt: number;
                                orphanFields: string[];
                                userConfigChanged: string[];
                            };
                        };
                    };
                };
                /** @description Invalid app definition */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Permission denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description App not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        post?: never;
        /** Delete an app and all of its rows */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description App deleted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            ok: true;
                        };
                    };
                };
                /** @description Permission denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description App not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        /**
         * Patch an app
         * @description Applies an RFC 7396 merge patch to the definition, with reusable elements, app actions, page elements, and model columns treated as atomic entries.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        name?: string;
                        description?: string | null;
                        definition?: {
                            [key: string]: unknown;
                        };
                        migration?: {
                            [key: string]: {
                                set: string | number | boolean;
                            } | {
                                from: string;
                                map?: {
                                    [key: string]: string | number | boolean;
                                };
                                else?: string | number | boolean | null;
                            } | {
                                /** @enum {boolean} */
                                coerce: true;
                                else?: string | number | boolean | null;
                            } | {
                                /** @enum {boolean} */
                                purge: true;
                            };
                        };
                        forceElementBreak?: string[];
                    };
                };
            };
            responses: {
                /** @description Patched app */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            app: {
                                id: string;
                                name: string;
                                description?: string;
                                definition: {
                                    [key: string]: unknown;
                                } | unknown[] | string | number | boolean | null;
                                definitionError?: {
                                    path: string;
                                    message: string;
                                }[];
                                createdAt: string;
                                updatedAt: string;
                            };
                            migration: {
                                scanned: number;
                                backfilled: number;
                                coerced: number;
                                mapped: number;
                                elsed: number;
                                purgedValues: number;
                                idxRebuilt: number;
                                orphanFields: string[];
                                userConfigChanged: string[];
                            };
                        };
                    };
                };
                /** @description Invalid app definition */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Permission denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description App not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/apps/{id}/models/{model}/rows": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List app model rows */
        get: {
            parameters: {
                query?: {
                    sort?: string;
                    limit?: number;
                };
                header?: never;
                path: {
                    id: string;
                    model: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Filtered app model rows */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            rows: ({
                                id: string;
                                createdAt: string;
                                updatedAt: string;
                                createdBy?: string;
                                updatedBy?: string;
                            } & {
                                [key: string]: unknown;
                            })[];
                            total: number;
                        };
                    };
                };
                /** @description Invalid filter or sort */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Permission denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description App or model not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        /** Create an app model row */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    model: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        values: {
                            [key: string]: unknown;
                        };
                    };
                };
            };
            responses: {
                /** @description Created row */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            row: {
                                id: string;
                                createdAt: string;
                                updatedAt: string;
                                createdBy?: string;
                                updatedBy?: string;
                            } & {
                                [key: string]: unknown;
                            };
                        };
                    };
                };
                /** @description Invalid row values */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Permission denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description App or model not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apps/{id}/models/{model}/rows/bulk": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Bulk-create app model rows */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    model: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        rows: {
                            values: {
                                [key: string]: unknown;
                            };
                        }[];
                    };
                };
            };
            responses: {
                /** @description Created rows */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            rows: ({
                                id: string;
                                createdAt: string;
                                updatedAt: string;
                                createdBy?: string;
                                updatedBy?: string;
                            } & {
                                [key: string]: unknown;
                            })[];
                        };
                    };
                };
                /** @description Invalid row values */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Permission denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description App or model not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apps/{id}/models/{model}/rows/{rowId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get an app model row */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    model: string;
                    rowId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description App model row */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            row: {
                                id: string;
                                createdAt: string;
                                updatedAt: string;
                                createdBy?: string;
                                updatedBy?: string;
                            } & {
                                [key: string]: unknown;
                            };
                        };
                    };
                };
                /** @description Permission denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description App, model, or row not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        /** Delete an app model row */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    model: string;
                    rowId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Row deleted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            ok: true;
                        };
                    };
                };
                /** @description Permission denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description App, model, or row not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        /** Patch an app model row */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    model: string;
                    rowId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        values: {
                            [key: string]: unknown;
                        };
                    };
                };
            };
            responses: {
                /** @description Updated row */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            row: {
                                id: string;
                                createdAt: string;
                                updatedAt: string;
                                createdBy?: string;
                                updatedBy?: string;
                            } & {
                                [key: string]: unknown;
                            };
                        };
                    };
                };
                /** @description Invalid row values */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Permission denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description App, model, or row not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/apps/{id}/queries/{name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Run a named app query */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    name: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Named query rows */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            rows: ({
                                id: string;
                                createdAt: string;
                                updatedAt: string;
                                createdBy?: string;
                                updatedBy?: string;
                            } & {
                                [key: string]: unknown;
                            })[];
                        };
                    };
                };
                /** @description Missing or invalid named query parameters */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Permission denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description App or query not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description App definition needs repair */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/apps/{id}/actions/{name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Run a custom app action
         * @description Runs the saved script, or creates the agent task, named by the app definition.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    name: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        input?: {
                            [key: string]: unknown;
                        };
                    };
                };
            };
            responses: {
                /** @description Action invoked */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            ok: boolean;
                            result?: unknown;
                            stdout: string;
                            error?: string;
                            durationMs: number;
                        } | {
                            /** @enum {boolean} */
                            ok: true;
                            taskId: string;
                            /** @enum {string} */
                            status: "backlog" | "unassigned" | "offered" | "reviewing" | "pending" | "in_progress" | "paused" | "completed" | "failed" | "cancelled" | "superseded";
                        };
                    };
                };
                /** @description Invalid action input or stale script reference */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Permission denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description App or action not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description App definition needs repair */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/db-query": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Execute a read-only SQL query */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        sql?: string;
                        /** @description Deprecated runtime alias for sql. */
                        query?: string;
                        /** @default [] */
                        params?: unknown[];
                    };
                };
            };
            responses: {
                /** @description Query results */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            columns: string[];
                            rows: unknown[][];
                            elapsed: number;
                            total: number;
                        };
                    };
                };
                /** @description Invalid or disallowed SQL */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/agents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List all agents
         * @description Returns agents WITHOUT the six identity-markdown blobs (`claudeMd`/`soulMd`/`identityMd`/`toolsMd`/`heartbeatMd`/`setupScript`) by default — they bloat the list by ~16 KB/agent and the overview never renders them. Pass `fields=full` to restore them, or fetch a single agent via `GET /api/agents/{id}`.
         */
        get: {
            parameters: {
                query?: {
                    include?: "tasks";
                    fields?: "full" | "slim";
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Agent list with capacity info */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            agents: (components["schemas"]["Agent"] & {
                                /** @default [] */
                                tasks: components["schemas"]["AgentTask"][];
                                capacity: {
                                    current: number;
                                    max: number;
                                    available: number;
                                };
                            })[];
                        };
                    };
                };
            };
        };
        put?: never;
        /** Register or re-register an agent */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        name: string;
                        isLead?: boolean;
                        description?: string;
                        role?: string;
                        capabilities?: string[];
                        maxTasks?: number;
                        /** @enum {string} */
                        provider?: "claude" | "codex" | "pi" | "devin" | "claude-managed" | "opencode";
                        /** @enum {string} */
                        harness_provider?: "claude" | "codex" | "pi" | "devin" | "claude-managed" | "opencode";
                    };
                };
            };
            responses: {
                /** @description Agent re-registered (already existed). Response includes `enabledCapabilities` — the server's capability flags (registered MCP tool groups), not the agent's declared skill tags. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Agent"] & {
                            enabledCapabilities: ("core" | "task-pool" | "scripts" | "config" | "prompt-templates" | "mcp" | "profiles" | "services" | "scheduling" | "memory" | "workflows" | "pages" | "metrics" | "kv" | "slack" | "tracker" | "skills" | "messaging" | "repo" | "agentmail" | "kapso" | "swarm-x")[];
                        };
                    };
                };
                /** @description Agent created. Response includes `enabledCapabilities` (see 200). */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Agent"] & {
                            enabledCapabilities: ("core" | "task-pool" | "scripts" | "config" | "prompt-templates" | "mcp" | "profiles" | "services" | "scheduling" | "memory" | "workflows" | "pages" | "metrics" | "kv" | "slack" | "tracker" | "skills" | "messaging" | "repo" | "agentmail" | "kapso" | "swarm-x")[];
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/agents/{id}/harness-provider": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Re-assign an agent's harness_provider (live)
         * @description Updates `agents.harness_provider` and upserts `swarm_config` (scope=agent, key=HARNESS_PROVIDER) so the worker's poll-loop reconciliation picks up the new provider within ~10s. No restart required. The swarm_config row is what actually drives the worker; the column mirrors the latest set value for dashboards.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        harness_provider: "claude" | "codex" | "pi" | "devin" | "claude-managed" | "opencode";
                    };
                };
            };
            responses: {
                /** @description Updated agent row */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Agent"] & {
                            capacity: {
                                current: number;
                                max: number;
                                available: number;
                            };
                        };
                    };
                };
                /** @description Validation error (unknown provider) */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Agent not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/agents/{id}/runtime": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Update an agent's runtime harness and default model
         * @description Updates `agents.harness_provider` and upserts agent-scoped `swarm_config` rows for HARNESS_PROVIDER, MODEL_OVERRIDE, and REASONING_EFFORT_OVERRIDE. The settings apply to future provider sessions. For `model` and `reasoning_effort`: omit the field to leave it unchanged, send `null` to clear the corresponding override, or send a value to set it.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        harness_provider: "claude" | "codex" | "pi" | "opencode";
                        model?: string | null;
                        /** @default false */
                        allow_custom_model?: boolean;
                        /** @enum {string|null} */
                        reasoning_effort?: "off" | "low" | "medium" | "high" | "xhigh" | "max" | null;
                    };
                };
            };
            responses: {
                /** @description Updated agent row */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Agent"] & {
                            capacity: {
                                current: number;
                                max: number;
                                available: number;
                            };
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Agent not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/agents/{id}/name": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Update agent name */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        name: string;
                    };
                };
            };
            responses: {
                /** @description Agent updated */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Agent"] & {
                            capacity: {
                                current: number;
                                max: number;
                                available: number;
                            };
                        };
                    };
                };
                /** @description Agent not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Name conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/agents/{id}/setup-script": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Fetch agent + global setup scripts for Docker entrypoint */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Setup scripts */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            setupScript: string | null;
                            globalSetupScript: string | null;
                        };
                    };
                };
                /** @description Agent not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/agents/{id}/profile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Update agent profile (role, description, capabilities, etc.) */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        role?: string;
                        description?: string;
                        capabilities?: string[];
                        claudeMd?: string;
                        soulMd?: string;
                        identityMd?: string;
                        setupScript?: string;
                        toolsMd?: string;
                        heartbeatMd?: string;
                        avatar?: {
                            /** @enum {string} */
                            type: "lucide";
                            icon: string;
                            color?: string;
                        } | null;
                        changeSource?: string;
                        changedByAgentId?: string;
                        changeReason?: string;
                    };
                };
            };
            responses: {
                /** @description Profile updated */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Agent"] & {
                            capacity: {
                                current: number;
                                max: number;
                                available: number;
                            };
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Agent not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/agents/{id}/activity": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Update agent last activity timestamp */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Activity updated */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/agents/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a single agent */
        get: {
            parameters: {
                query?: {
                    include?: "tasks";
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Agent with capacity info */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Agent"] & {
                            /** @default [] */
                            tasks: components["schemas"]["AgentTask"][];
                            capacity: {
                                current: number;
                                max: number;
                                available: number;
                            };
                        };
                    };
                };
                /** @description Agent not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/agents/{id}/credential-status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Single-agent credential-status snapshot for the dashboard */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Credential status payload */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            agentId: string;
                            name: string;
                            /** @enum {string} */
                            status: "idle" | "busy" | "offline" | "waiting_for_credentials";
                            missing: string[];
                            /** @enum {string|null} */
                            provider: "claude" | "codex" | "pi" | "devin" | "claude-managed" | "opencode" | null;
                            /** @enum {string|null} */
                            harnessProvider: "claude" | "codex" | "pi" | "devin" | "claude-managed" | "opencode" | null;
                            credStatus: components["schemas"]["AgentCredStatus"] | null;
                            lastCheckedAt: string;
                        };
                    };
                };
                /** @description Agent not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        /** Worker self-report of credential readiness (Phase 3 boot loop) */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        ready?: boolean;
                        missing?: string[] | null;
                        cred_status?: components["schemas"]["AgentCredStatus"] | null;
                        latest_model?: components["schemas"]["AgentLatestModel"];
                    };
                };
            };
            responses: {
                /** @description State updated; returns the agent row. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Agent"] & {
                            capacity: {
                                current: number;
                                max: number;
                                available: number;
                            };
                        };
                    };
                };
                /** @description Agent not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/agents/credential-status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Bulk credential-status across all agents (powers the dashboard) */
        get: {
            parameters: {
                query?: {
                    status?: "idle" | "busy" | "offline" | "waiting_for_credentials";
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description List of {agentId, status, missing[], lastCheckedAt} */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            agents: {
                                agentId: string;
                                name: string;
                                /** @enum {string} */
                                status: "idle" | "busy" | "offline" | "waiting_for_credentials";
                                missing: string[];
                                /** @enum {string|null} */
                                provider: "claude" | "codex" | "pi" | "devin" | "claude-managed" | "opencode" | null;
                                /** @enum {string|null} */
                                harnessProvider: "claude" | "codex" | "pi" | "devin" | "claude-managed" | "opencode" | null;
                                credStatus: components["schemas"]["AgentCredStatus"] | null;
                                lastCheckedAt: string;
                            }[];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/approval-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List approval requests with optional filters */
        get: {
            parameters: {
                query?: {
                    status?: string;
                    workflowRunId?: string;
                    limit?: number | null;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description List of approval requests */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            approvalRequests: {
                                id: string;
                                title: string;
                                questions: {
                                    id: string;
                                    /** @enum {string} */
                                    type: "approval" | "text" | "single-select" | "multi-select" | "boolean";
                                    label: string;
                                    required?: boolean;
                                    description?: string;
                                    placeholder?: string;
                                    multiline?: boolean;
                                    options?: {
                                        value: string;
                                        label: string;
                                        description?: string;
                                    }[];
                                    minSelections?: number;
                                    maxSelections?: number;
                                    defaultValue?: boolean;
                                }[];
                                workflowRunId: string | null;
                                workflowRunStepId: string | null;
                                sourceTaskId: string | null;
                                approvers: {
                                    users?: string[];
                                    roles?: string[];
                                    policy: "any" | "all" | {
                                        min: number;
                                    };
                                };
                                /** @enum {string} */
                                status: "pending" | "approved" | "rejected" | "timeout";
                                responses: {
                                    [key: string]: unknown;
                                } | null;
                                resolvedBy: string | null;
                                resolvedAt: string | null;
                                timeoutSeconds: number | null;
                                expiresAt: string | null;
                                notificationChannels: {
                                    /** @enum {string} */
                                    channel: "slack" | "email";
                                    target: string;
                                    messageTs?: string;
                                }[] | null;
                                createdBy?: string;
                                createdAt: string;
                                updatedAt: string;
                            }[];
                        };
                    };
                };
            };
        };
        put?: never;
        /** Create a new approval request */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        title: string;
                        questions: {
                            id: string;
                            /** @enum {string} */
                            type: "approval" | "text" | "single-select" | "multi-select" | "boolean";
                            label: string;
                            required?: boolean;
                            description?: string;
                            placeholder?: string;
                            multiline?: boolean;
                            options?: {
                                value: string;
                                label: string;
                                description?: string;
                            }[];
                            minSelections?: number;
                            maxSelections?: number;
                            defaultValue?: boolean;
                        }[];
                        approvers: {
                            users?: string[];
                            roles?: string[];
                            policy: "any" | "all" | {
                                min: number;
                            };
                        };
                        /** Format: uuid */
                        workflowRunId?: string;
                        /** Format: uuid */
                        workflowRunStepId?: string;
                        /** Format: uuid */
                        sourceTaskId?: string;
                        timeoutSeconds?: number;
                        notifications?: {
                            /** @enum {string} */
                            channel: "slack" | "email";
                            target: string;
                        }[];
                    };
                };
            };
            responses: {
                /** @description Approval request created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            approvalRequest: {
                                id: string;
                                title: string;
                                questions: {
                                    id: string;
                                    /** @enum {string} */
                                    type: "approval" | "text" | "single-select" | "multi-select" | "boolean";
                                    label: string;
                                    required?: boolean;
                                    description?: string;
                                    placeholder?: string;
                                    multiline?: boolean;
                                    options?: {
                                        value: string;
                                        label: string;
                                        description?: string;
                                    }[];
                                    minSelections?: number;
                                    maxSelections?: number;
                                    defaultValue?: boolean;
                                }[];
                                workflowRunId: string | null;
                                workflowRunStepId: string | null;
                                sourceTaskId: string | null;
                                approvers: {
                                    users?: string[];
                                    roles?: string[];
                                    policy: "any" | "all" | {
                                        min: number;
                                    };
                                };
                                /** @enum {string} */
                                status: "pending" | "approved" | "rejected" | "timeout";
                                responses: {
                                    [key: string]: unknown;
                                } | null;
                                resolvedBy: string | null;
                                resolvedAt: string | null;
                                timeoutSeconds: number | null;
                                expiresAt: string | null;
                                notificationChannels: {
                                    /** @enum {string} */
                                    channel: "slack" | "email";
                                    target: string;
                                    messageTs?: string;
                                }[] | null;
                                createdBy?: string;
                                createdAt: string;
                                updatedAt: string;
                            };
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/approval-requests/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get approval request details */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Approval request details */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            approvalRequest: {
                                id: string;
                                title: string;
                                questions: {
                                    id: string;
                                    /** @enum {string} */
                                    type: "approval" | "text" | "single-select" | "multi-select" | "boolean";
                                    label: string;
                                    required?: boolean;
                                    description?: string;
                                    placeholder?: string;
                                    multiline?: boolean;
                                    options?: {
                                        value: string;
                                        label: string;
                                        description?: string;
                                    }[];
                                    minSelections?: number;
                                    maxSelections?: number;
                                    defaultValue?: boolean;
                                }[];
                                workflowRunId: string | null;
                                workflowRunStepId: string | null;
                                sourceTaskId: string | null;
                                approvers: {
                                    users?: string[];
                                    roles?: string[];
                                    policy: "any" | "all" | {
                                        min: number;
                                    };
                                };
                                /** @enum {string} */
                                status: "pending" | "approved" | "rejected" | "timeout";
                                responses: {
                                    [key: string]: unknown;
                                } | null;
                                resolvedBy: string | null;
                                resolvedAt: string | null;
                                timeoutSeconds: number | null;
                                expiresAt: string | null;
                                notificationChannels: {
                                    /** @enum {string} */
                                    channel: "slack" | "email";
                                    target: string;
                                    messageTs?: string;
                                }[] | null;
                                createdBy?: string;
                                createdAt: string;
                                updatedAt: string;
                            };
                        };
                    };
                };
                /** @description Not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/approval-requests/{id}/respond": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Submit a response to an approval request */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        responses: {
                            [key: string]: unknown;
                        };
                        respondedBy?: string;
                    };
                };
            };
            responses: {
                /** @description Response recorded */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            approvalRequest: {
                                id: string;
                                title: string;
                                questions: {
                                    id: string;
                                    /** @enum {string} */
                                    type: "approval" | "text" | "single-select" | "multi-select" | "boolean";
                                    label: string;
                                    required?: boolean;
                                    description?: string;
                                    placeholder?: string;
                                    multiline?: boolean;
                                    options?: {
                                        value: string;
                                        label: string;
                                        description?: string;
                                    }[];
                                    minSelections?: number;
                                    maxSelections?: number;
                                    defaultValue?: boolean;
                                }[];
                                workflowRunId: string | null;
                                workflowRunStepId: string | null;
                                sourceTaskId: string | null;
                                approvers: {
                                    users?: string[];
                                    roles?: string[];
                                    policy: "any" | "all" | {
                                        min: number;
                                    };
                                };
                                /** @enum {string} */
                                status: "pending" | "approved" | "rejected" | "timeout";
                                responses: {
                                    [key: string]: unknown;
                                } | null;
                                resolvedBy: string | null;
                                resolvedAt: string | null;
                                timeoutSeconds: number | null;
                                expiresAt: string | null;
                                notificationChannels: {
                                    /** @enum {string} */
                                    channel: "slack" | "email";
                                    target: string;
                                    messageTs?: string;
                                }[] | null;
                                createdBy?: string;
                                createdAt: string;
                                updatedAt: string;
                            };
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Already resolved */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/assets/key-audit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Audit asset namespace invariants
         * @description Operator-only check for structural key validity, personal-user references, and logical provider mapping drift. Repeated logical keys are valid and are never reported as conflicts.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Asset namespace audit result */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            ok: boolean;
                            structuralValid: boolean;
                            checked: number;
                            fatalCount: number;
                            warningCount: number;
                            issues: {
                                /** @enum {string} */
                                severity: "fatal" | "warning";
                                /** @enum {string} */
                                code: "missing-key" | "noncanonical-key" | "unknown-personal-user" | "missing-provider-mapping" | "provider-mapping-drift";
                                /** @enum {string} */
                                entityType: "task" | "workflow" | "schedule" | "page" | "file";
                                entityId: string;
                                message: string;
                            }[];
                        };
                    };
                };
                /** @description Operator access required */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/assets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List lightweight cross-entity asset summaries
         * @description Returns only entity type, ID, namespace key, label, update time, and optional provider reference. It never returns task briefs, page bodies, workflow definitions, secrets, or file bytes. Personal keys are namespace labels, not a privacy or read-visibility guarantee.
         */
        get: {
            parameters: {
                query?: {
                    /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                    keyPrefix?: string;
                    /** @description Comma-separated task,workflow,schedule,page,file list */
                    types?: string;
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Lightweight asset summary list */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            assets: components["schemas"]["AssetSummary"][];
                            count: number;
                        };
                    };
                };
                /** @description Invalid entity type */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/assets/mappings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Register a logical namespace for a provider object
         * @description Idempotently maps a provider tuple to a logical swarm key without moving, renaming, reading, or writing the remote object.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        providerId: string;
                        orgId?: string;
                        driveId?: string;
                        providerKey: string;
                        /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                        key?: string;
                    };
                };
            };
            responses: {
                /** @description Mapping registered */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AssetKeyMapping"];
                    };
                };
                /** @description Invalid provider tuple or namespace */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Operator access required or personal namespace not authorized */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/assets/{entityType}/{id}/key": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Move an asset to another logical namespace
         * @description Updates namespace metadata only. Provider-backed files keep the same provider key, org, and drive; no remote move occurs. Personal keys are labels, not a privacy guarantee.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    entityType: "task" | "workflow" | "schedule" | "page" | "file";
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                        key: string;
                    };
                };
            };
            responses: {
                /** @description Asset namespace updated */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            entityType: "task" | "workflow" | "schedule" | "page" | "file";
                            id: string;
                            /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                            key: string;
                        };
                    };
                };
                /** @description Invalid namespace */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Move not authorized */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Asset not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Moves blocked until audit warnings are repaired */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/budgets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List all configured budget rows */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Budget list */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            budgets: components["schemas"]["Budget"][];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/budgets/refusals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List recent budget refusal notifications */
        get: {
            parameters: {
                query?: {
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Recent budget refusals (newest first) */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            refusals: components["schemas"]["BudgetRefusalNotification"][];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/budgets/{scope}/{scopeId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a single budget row */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    scope: "global" | "agent" | "user";
                    /** @description Scope identifier — empty string for global, agent UUID otherwise */
                    scopeId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Budget row */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Budget"];
                    };
                };
                /** @description Budget not configured */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        /** Create or update a budget row */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    scope: "global" | "agent" | "user";
                    /** @description Scope identifier — empty string for global, agent UUID otherwise */
                    scopeId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        dailyBudgetUsd: number;
                    };
                };
            };
            responses: {
                /** @description Budget upserted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Budget"];
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        post?: never;
        /** Delete a budget row */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    scope: "global" | "agent" | "user";
                    /** @description Scope identifier — empty string for global, agent UUID otherwise */
                    scopeId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Budget deleted */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Budget not configured */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/oauth/keep-warm/codex": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Locked keep-warm refresh sweep across all Codex OAuth pool slots
         * @description Enumerates codex_oauth_* slots and refreshes any older than ~7 days through the same locked getValidCodexOAuth path used at task time. Skips slots already benched by codex-auth-expiry-watch.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Per-slot keep-warm outcomes */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            results: ({
                                slot: number;
                                keySuffix: string;
                                /** @enum {string} */
                                outcome: "warm";
                            } | {
                                slot: number;
                                keySuffix: string;
                                /** @enum {string} */
                                outcome: "refreshed";
                            } | {
                                slot: number;
                                keySuffix: string;
                                /** @enum {string} */
                                outcome: "skipped-benched";
                            } | {
                                slot: number;
                                /** @enum {string} */
                                outcome: "no-credentials";
                            } | {
                                slot: number;
                                keySuffix: string;
                                /** @enum {string} */
                                outcome: "failed";
                                reason: string;
                            })[];
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/config/resolved": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get resolved config (merged global + agent + repo scopes) */
        get: {
            parameters: {
                query?: {
                    agentId?: string;
                    repoId?: string;
                    includeSecrets?: "true" | "false";
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Resolved config entries */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            configs: components["schemas"]["SwarmConfig"][];
                            message?: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/config/env-presence": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Check which of the given env var keys are currently set in process.env (presence only, no values) */
        get: {
            parameters: {
                query: {
                    keys: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Map of key -> boolean (true iff set in process.env) */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            presence: {
                                [key: string]: boolean;
                            };
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/config/reload": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Reload global swarm_config into process.env (override=true) and re-init integrations (Slack, GitHub, Linear, AgentMail) */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": Record<string, never>;
                };
            };
            responses: {
                /** @description Reload result */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                            configsLoaded: number;
                            keysUpdated: string[];
                            integrationsReinitialized: string[];
                        };
                    };
                };
                /** @description Reload failed */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/config/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a single config entry by ID */
        get: {
            parameters: {
                query?: {
                    includeSecrets?: "true" | "false";
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Config entry */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwarmConfig"] & {
                            message?: string;
                        };
                    };
                };
                /** @description Config not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        /** Delete a config entry by ID (including legacy reserved rows for cleanup). Global-scope deletes auto-trigger an integrations reload. */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Config deleted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                        };
                    };
                };
                /** @description Config not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/config": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List config entries with optional filters */
        get: {
            parameters: {
                query?: {
                    scope?: string;
                    scopeId?: string;
                    includeSecrets?: "true" | "false";
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description List of config entries */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            configs: components["schemas"]["SwarmConfig"][];
                            message?: string;
                        };
                    };
                };
            };
        };
        /** Create or update a config entry (reserved env-only keys are rejected). Global-scope writes auto-trigger an integrations reload (debounced ~250ms) so Slack/GitHub/Linear/Jira/AgentMail pick up new credentials without an explicit /api/config/reload call. */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        scope: "global" | "agent" | "repo";
                        scopeId?: string | null;
                        key: string;
                        value?: unknown;
                        isSecret?: boolean;
                        envPath?: string | null;
                        description?: string | null;
                    };
                };
            };
            responses: {
                /** @description Config entry upserted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwarmConfig"];
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/tasks/{id}/context": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get context usage history for a task */
        get: {
            parameters: {
                query?: {
                    limit?: number;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Context snapshot history */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            snapshots: components["schemas"]["ContextSnapshot"][];
                            summary: {
                                compactionCount: number;
                                peakContextPercent: number | null;
                                peakContextTokens: number | null;
                                contextWindowSize: number | null;
                                snapshotCount: number;
                            };
                        };
                    };
                };
                /** @description Task not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        /** Record a context usage snapshot for a task */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        eventType: "progress" | "compaction" | "completion";
                        sessionId: string;
                        contextUsedTokens?: number;
                        contextTotalTokens?: number;
                        contextPercent?: number;
                        /** @enum {string} */
                        compactTrigger?: "auto" | "manual" | "auto-inferred";
                        preCompactTokens?: number;
                        cumulativeInputTokens?: number;
                        cumulativeOutputTokens?: number;
                        /** @enum {string} */
                        contextFormula?: "input-cache-output" | "input-cache-no-output" | "input-output-no-cache" | "peak-proxy" | "pi-delegated" | "harness-reported" | "unknown";
                    };
                };
            };
            responses: {
                /** @description Snapshot recorded */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            ok: true;
                            /** Format: uuid */
                            snapshotId: string;
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Task not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/ecosystem": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get PM2 ecosystem config for agent services */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description PM2 ecosystem config */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            apps: {
                                name: string;
                                script: string;
                                cwd?: string;
                                interpreter?: string;
                                args?: string[];
                                env?: {
                                    [key: string]: string;
                                };
                            }[];
                        };
                    };
                };
                /** @description Missing X-Agent-ID */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/keys/report-usage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Record which API key was used for a task */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        keyType: string;
                        keySuffix: string;
                        keyIndex: number;
                        /** Format: uuid */
                        taskId?: string;
                        scope?: string;
                        scopeId?: string;
                    };
                };
            };
            responses: {
                /** @description Usage recorded */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                            message: string;
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/keys/report-rate-limit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Mark an API key as rate-limited */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        keyType: string;
                        keySuffix: string;
                        keyIndex: number;
                        /** Format: date-time */
                        rateLimitedUntil: string;
                        scope?: string;
                        scopeId?: string;
                    };
                };
            };
            responses: {
                /** @description Key marked as rate-limited */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                            message: string;
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/keys/report-rate-limit-windows": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Record provider-emitted rate-limit window telemetry for an API key */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        keyType: string;
                        keySuffix: string;
                        keyIndex: number;
                        windows: {
                            [key: string]: {
                                status: string;
                                utilization?: number;
                                resetsAt?: number;
                                isUsingOverage?: boolean;
                                surpassedThreshold?: number;
                                /** Format: date-time */
                                lastSeenAt: string;
                            };
                        };
                        scope?: string;
                        scopeId?: string;
                    };
                };
            };
            responses: {
                /** @description Rate-limit window telemetry recorded */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                            message: string;
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/keys/available": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get available (non-rate-limited) key indices for a credential type */
        get: {
            parameters: {
                query: {
                    keyType: string;
                    totalKeys: number;
                    scope?: string;
                    scopeId?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description List of available key indices */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                            availableIndices: number[];
                            totalKeys: number;
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/keys/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get all API key status records */
        get: {
            parameters: {
                query?: {
                    keyType?: string;
                    scope?: string;
                    scopeId?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description List of key status records */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                            keys: {
                                id: string;
                                keyType: string;
                                keySuffix: string;
                                keyIndex: number;
                                scope: string;
                                scopeId: string | null;
                                status: string;
                                rateLimitedUntil: string | null;
                                lastUsedAt: string | null;
                                lastRateLimitAt: string | null;
                                totalUsageCount: number;
                                rateLimitCount: number;
                                name: string | null;
                                provider: string;
                                rateLimitWindows: {
                                    [key: string]: {
                                        status: string;
                                        utilization?: number;
                                        resetsAt?: number;
                                        isUsingOverage?: boolean;
                                        surpassedThreshold?: number;
                                        /** Format: date-time */
                                        lastSeenAt: string;
                                    };
                                };
                                createdAt: string;
                                updatedAt: string;
                            }[];
                        };
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/keys/costs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get aggregated cost data per API key */
        get: {
            parameters: {
                query?: {
                    keyType?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Per-key cost aggregation */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                            costs: {
                                keyType: string;
                                keySuffix: string;
                                totalCost: number;
                                totalInputTokens: number;
                                totalOutputTokens: number;
                                taskCount: number;
                            }[];
                        };
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/keys/name": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Set or clear the human-friendly label on a pooled credential */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        keyType: string;
                        keySuffix: string;
                        name: string | null;
                        scope?: string;
                        scopeId?: string;
                    };
                };
            };
            responses: {
                /** @description Name updated */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                            keyType: string;
                            keySuffix: string;
                            name: string | null;
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Key not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/keys/clear-rate-limit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Clear rate-limited status for a key after a successful use proves it is healthy */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        keyType: string;
                        keySuffix: string;
                        scope?: string;
                        scopeId?: string;
                    };
                };
            };
            responses: {
                /** @description Rate limit cleared (or key was not rate-limited) */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                            cleared: boolean;
                            message: string;
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Query events with filters */
        get: {
            parameters: {
                query?: {
                    category?: "tool" | "skill" | "session" | "api" | "task" | "workflow" | "system";
                    event?: "tool.start" | "tool.end" | "skill.invoke" | "skill.complete" | "session.start" | "session.end" | "session.resume" | "session.cost" | "api.request" | "api.error" | "task.poll" | "task.assign" | "task.timeout" | "workflow.step.start" | "workflow.step.end" | "workflow.run.start" | "workflow.run.end" | "system.boot" | "system.migration" | "system.error" | "script.global_upsert" | "schedule.deleted";
                    status?: "ok" | "error" | "timeout" | "skipped";
                    source?: "worker" | "api" | "hook" | "scheduler" | "cli";
                    agentId?: string;
                    taskId?: string;
                    sessionId?: string;
                    since?: string;
                    until?: string;
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description List of events */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            events: components["schemas"]["SwarmEvent"][];
                        };
                    };
                };
            };
        };
        put?: never;
        /** Store a single event */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        category: "tool" | "skill" | "session" | "api" | "task" | "workflow" | "system";
                        /** @enum {string} */
                        event: "tool.start" | "tool.end" | "skill.invoke" | "skill.complete" | "session.start" | "session.end" | "session.resume" | "session.cost" | "api.request" | "api.error" | "task.poll" | "task.assign" | "task.timeout" | "workflow.step.start" | "workflow.step.end" | "workflow.run.start" | "workflow.run.end" | "system.boot" | "system.migration" | "system.error" | "script.global_upsert" | "schedule.deleted";
                        /** @enum {string} */
                        status?: "ok" | "error" | "timeout" | "skipped";
                        /** @enum {string} */
                        source: "worker" | "api" | "hook" | "scheduler" | "cli";
                        agentId?: string;
                        taskId?: string;
                        sessionId?: string;
                        parentEventId?: string;
                        numericValue?: number;
                        durationMs?: number;
                        data?: {
                            [key: string]: unknown;
                        };
                    };
                };
            };
            responses: {
                /** @description Event stored */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                            event: components["schemas"]["SwarmEvent"];
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/events/batch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Store multiple events in a batch */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        events: {
                            /** @enum {string} */
                            category: "tool" | "skill" | "session" | "api" | "task" | "workflow" | "system";
                            /** @enum {string} */
                            event: "tool.start" | "tool.end" | "skill.invoke" | "skill.complete" | "session.start" | "session.end" | "session.resume" | "session.cost" | "api.request" | "api.error" | "task.poll" | "task.assign" | "task.timeout" | "workflow.step.start" | "workflow.step.end" | "workflow.run.start" | "workflow.run.end" | "system.boot" | "system.migration" | "system.error" | "script.global_upsert" | "schedule.deleted";
                            /** @enum {string} */
                            status?: "ok" | "error" | "timeout" | "skipped";
                            /** @enum {string} */
                            source: "worker" | "api" | "hook" | "scheduler" | "cli";
                            agentId?: string;
                            taskId?: string;
                            sessionId?: string;
                            parentEventId?: string;
                            numericValue?: number;
                            durationMs?: number;
                            data?: {
                                [key: string]: unknown;
                            };
                        }[];
                    };
                };
            };
            responses: {
                /** @description Events stored */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                            count: number;
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/events/counts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get event counts grouped by event name */
        get: {
            parameters: {
                query?: {
                    category?: "tool" | "skill" | "session" | "api" | "task" | "workflow" | "system";
                    source?: "worker" | "api" | "hook" | "scheduler" | "cli";
                    agentId?: string;
                    taskId?: string;
                    sessionId?: string;
                    since?: string;
                    until?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Event counts */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            counts: {
                                event: string;
                                count: number;
                            }[];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/favorites": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List favorites for the authenticated principal */
        get: {
            parameters: {
                query?: {
                    itemType?: "page" | "workflow" | "schedule";
                    itemIds?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Favorite rows and favorite item ids */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            favorites: components["schemas"]["UserFavorite"][];
                            favoriteIds: string[];
                        };
                    };
                };
                /** @description No authenticated principal context */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        /** Set favorite state for an item */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        itemType: "page" | "workflow" | "schedule";
                        itemId: string;
                        favorite: boolean;
                    };
                };
            };
            responses: {
                /** @description Favorite state */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            favorite: boolean;
                            /** @enum {string} */
                            itemType: "page" | "workflow" | "schedule";
                            itemId: string;
                            row: components["schemas"]["UserFavorite"] | null;
                        };
                    };
                };
                /** @description No authenticated principal context */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/fs/capabilities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get active file-storage provider capabilities */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Active provider capabilities */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            providerId: string;
                            capabilities: {
                                signedUrl: {
                                    supported: boolean;
                                    maxExpiresIn?: number;
                                };
                                search?: boolean;
                                comments?: boolean;
                                versioning?: boolean;
                            };
                        };
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/fs/agent-credentials": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Ensure agent-scoped agent-fs credentials for the current agent
         * @description Internal runner endpoint. The API server owns agent-fs bootstrap credentials, registers/invites the caller to the shared org when needed, and stores the generated key as an agent-scoped secret. The API key is never returned.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": Record<string, never>;
                };
            };
            responses: {
                /** @description Credential state */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            enabled: boolean;
                            created: boolean;
                            agentId: string;
                            email?: string;
                            orgId?: string;
                            driveId?: string;
                        };
                    };
                };
                /** @description Missing agent id */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Provisioning failed */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/fs/members/invite": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Invite an external member into the agent-fs shared org
         * @description The API server performs the invite with its own bootstrap credentials (which are API-only and never served over HTTP), provisioning the shared org/drive first when needed. Intended for the cloud control plane's Connect-to-Drive flow. No keys are returned; the invitee obtains their own key via agent-fs registration.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: email */
                        email: string;
                        /**
                         * @default editor
                         * @enum {string}
                         */
                        role?: "viewer" | "editor" | "admin";
                    };
                };
            };
            responses: {
                /** @description Invite state ({ orgId, invited }) */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            orgId: string;
                            invited: boolean;
                        };
                    };
                };
                /** @description Invalid body */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Provisioning or invite failed */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/fs/tasks/{taskId}/files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List task file attachments */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    taskId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Task file attachments */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            attachments: components["schemas"]["TaskAttachment"][];
                        };
                    };
                };
                /** @description Task not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        /**
         * Upload a binary task file attachment
         * @description Accepts a raw binary request body. Pass the display/path name as the `name` query parameter.
         */
        post: {
            parameters: {
                query: {
                    name: string;
                    intent?: string;
                    description?: string;
                    isPrimary?: "true" | "false";
                };
                header?: never;
                path: {
                    taskId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Uploaded task attachment */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TaskAttachment"];
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Caller cannot mutate this task */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Task not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Upload exceeds 50 MiB */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/fs/tasks/{taskId}/files/{attachmentId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get task file attachment metadata */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    taskId: string;
                    attachmentId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Task attachment metadata */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["TaskAttachment"];
                    };
                };
                /** @description Task or attachment not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        /** Delete a task file attachment */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    taskId: string;
                    attachmentId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Attachment deleted */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Caller cannot mutate this task */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Task or attachment not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/fs/tasks/{taskId}/files/{attachmentId}/raw": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Download raw task file bytes
         * @description Streams raw bytes. File content is not secret-scrubbed.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    taskId: string;
                    attachmentId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Raw file bytes */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Task, attachment, or provider object not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/fs/tasks/{taskId}/files/{attachmentId}/signed-url": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Create a provider signed GET URL for a task file */
        get: {
            parameters: {
                query?: {
                    expiresIn?: number;
                };
                header?: never;
                path: {
                    taskId: string;
                    attachmentId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Signed URL */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            url: string;
                            expiresIn: number;
                        };
                    };
                };
                /** @description Task, attachment, or provider object not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Active provider does not support signed URLs */
                501: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/heartbeat/sweep": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Trigger an immediate heartbeat sweep */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Sweep completed successfully */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                            message: string;
                        };
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/heartbeat/checklist": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Trigger an immediate heartbeat checklist check */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Checklist check completed successfully */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                            message: string;
                        };
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/inbox-state": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List inbox-item state rows for a user */
        get: {
            parameters: {
                query: {
                    userId: string;
                    status?: "open" | "snoozed" | "dismissed" | "done";
                    itemType?: "approval" | "credential_missing" | "broken_task" | "to_read" | "to_start_template";
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Inbox state rows */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: components["schemas"]["InboxItemState"][];
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Upsert per-user dismiss/snooze/done state for an inbox item */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        userId: string;
                        /** @enum {string} */
                        itemType: "approval" | "credential_missing" | "broken_task" | "to_read" | "to_start_template";
                        itemId: string;
                        /** @enum {string} */
                        status: "open" | "snoozed" | "dismissed" | "done";
                        /** Format: date-time */
                        snoozeUntil?: string;
                    };
                };
            };
            responses: {
                /** @description Upserted inbox state row */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            item: components["schemas"]["InboxItemState"];
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/integrations/claude-managed/test": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Test the claude-managed integration: resolves ANTHROPIC_API_KEY + MANAGED_AGENT_ID from swarm_config and calls beta.agents.retrieve. */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": Record<string, never>;
                };
            };
            responses: {
                /** @description Connection result — `{ ok: true, agentName, model }` on success or `{ ok: false, error }` on any failure (missing config, Anthropic API error). Always 200 OK. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            ok: true;
                            agentName: string | null;
                            model: string | null;
                        } | {
                            /** @enum {boolean} */
                            ok: false;
                            error: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/mcp-user/config": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get server-derived config for end-user MCP clients. */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Server-derived MCP user config. `mcpBaseUrl` is the API server base URL and `mcpUserUrl` appends `/mcp-user`. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            mcpBaseUrl: string;
                            mcpUserUrl: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/kv/{key}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a KV entry by key (namespace resolved from request headers) */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    key: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description KV entry */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["KvEntry"];
                    };
                };
                /** @description Validation error or unresolvable namespace */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description KV entry not found or expired */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        /** Upsert a KV entry by key (namespace resolved from request headers) */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    key: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        value?: unknown;
                        /** @enum {string} */
                        valueType?: "json" | "string" | "integer";
                        expiresInSec?: number;
                    };
                };
            };
            responses: {
                /** @description KV entry stored */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["KvEntry"];
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Caller may not write this namespace */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description INCR collision: existing value_type is not 'integer' */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Body exceeds 2 MiB */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        post?: never;
        /** Delete a KV entry by key (namespace resolved from request headers) */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    key: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description KV entry deleted */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Validation error or unresolvable namespace */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Caller may not write this namespace */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description KV entry not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/kv/{key}/incr": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Atomically increment an integer KV entry (header-resolved namespace) */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    key: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        by?: number;
                    } | null;
                };
            };
            responses: {
                /** @description KV entry stored */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["KvEntry"];
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Caller may not write this namespace */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description INCR collision: existing value_type is not 'integer' */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Body exceeds 2 MiB */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/kv": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List KV entries in the header-resolved namespace */
        get: {
            parameters: {
                query?: {
                    prefix?: string;
                    limit?: number;
                    offset?: number | null;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description KV entries in the resolved namespace */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            entries: components["schemas"]["KvEntry"][];
                            total: number;
                            namespace: string;
                        };
                    };
                };
                /** @description Validation error or unresolvable namespace */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/kv/_/{namespace}/{key}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a KV entry by explicit namespace + key */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    namespace: string;
                    key: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description KV entry */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["KvEntry"];
                    };
                };
                /** @description Validation error or unresolvable namespace */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description KV entry not found or expired */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        /** Upsert a KV entry by explicit namespace + key */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    namespace: string;
                    key: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        value?: unknown;
                        /** @enum {string} */
                        valueType?: "json" | "string" | "integer";
                        expiresInSec?: number;
                    };
                };
            };
            responses: {
                /** @description KV entry stored */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["KvEntry"];
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Caller may not write this namespace */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description INCR collision: existing value_type is not 'integer' */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Body exceeds 2 MiB */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        post?: never;
        /** Delete a KV entry by explicit namespace + key */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    namespace: string;
                    key: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description KV entry deleted */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Caller may not write this namespace */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description KV entry not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/kv/_/{namespace}/{key}/incr": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Atomically increment an integer KV entry (explicit namespace) */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    namespace: string;
                    key: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        by?: number;
                    } | null;
                };
            };
            responses: {
                /** @description KV entry stored */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["KvEntry"];
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Caller may not write this namespace */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description INCR collision: existing value_type is not 'integer' */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Body exceeds 2 MiB */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/kv/_/{namespace}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List KV entries in an explicit namespace */
        get: {
            parameters: {
                query?: {
                    prefix?: string;
                    limit?: number;
                    offset?: number | null;
                };
                header?: never;
                path: {
                    namespace: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description KV entries in the resolved namespace */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            entries: components["schemas"]["KvEntry"][];
                            total: number;
                            namespace: string;
                        };
                    };
                };
                /** @description Validation error or unresolvable namespace */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/memory/index": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Ingest content into memory system (async embedding) */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        agentId?: string;
                        content: string;
                        name: string;
                        /** @enum {string} */
                        scope: "agent" | "swarm";
                        /** @enum {string} */
                        source: "manual" | "file_index" | "session_summary" | "task_completion";
                        /** Format: uuid */
                        sourceTaskId?: string;
                        sourcePath?: string;
                        tags?: string[];
                        persistMemory?: boolean;
                        contextKey?: string;
                    };
                };
            };
            responses: {
                /** @description Content queued for embedding */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            queued: boolean;
                            memoryIds: string[];
                            skipped?: string;
                            edited?: boolean;
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/memory/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Search memories by natural language query */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        query: string;
                        /** @description Why you are searching. Required for agent recall-edge tracking; omit for UI browse/search calls. */
                        intent?: string;
                        /** @default 5 */
                        limit?: number;
                        /**
                         * @default all
                         * @enum {string}
                         */
                        scope?: "agent" | "swarm" | "all";
                        /** @enum {string} */
                        source?: "manual" | "file_index" | "session_summary" | "task_completion";
                    };
                };
            };
            responses: {
                /** @description Search results */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            results: {
                                id: string;
                                name: string;
                                content: string;
                                similarity: number;
                                rawSimilarity?: number;
                                compositeScore?: number;
                                /** @enum {string} */
                                retrievalSource?: "vec" | "fts" | "hybrid" | "fallback" | "graph";
                                /** @enum {string} */
                                source: "manual" | "file_index" | "session_summary" | "task_completion";
                                /** @enum {string} */
                                scope: "agent" | "swarm";
                                tags: string[];
                            }[];
                        };
                    };
                };
                /** @description Missing query or agent ID */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/memory/edit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Edit a single memory in place while preserving its ID and usefulness posterior. Modes: 'replace' overwrites entire content; 'exact' performs surgical find-and-replace of oldString→newString (fails if missing or ambiguous) */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        memoryId?: string;
                        key?: string;
                        /** @enum {string} */
                        scope?: "agent" | "swarm";
                        /**
                         * @default replace
                         * @enum {string}
                         */
                        mode?: "replace" | "exact";
                        content?: string;
                        oldString?: string;
                        newString?: string;
                        intent: string;
                        expectedVersion?: number;
                    };
                };
            };
            responses: {
                /** @description Memory edited */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            memory: components["schemas"]["AgentMemory"];
                            changed: boolean;
                            previousVersion: number;
                            version: number;
                            contentHash: string;
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Memory not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Version conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/memory/re-embed": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Re-embed all memories using the current embedding provider */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /**
                         * Format: uuid
                         * @description Re-embed only this agent's memories. Omit for all.
                         */
                        agentId?: string;
                        /**
                         * @description Memories per batch
                         * @default 20
                         */
                        batchSize?: number;
                    };
                };
            };
            responses: {
                /** @description Re-embedding started */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            started: boolean;
                            totalMemories: number;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/memory/list": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** List or semantically search memories across all agents (debug/admin) */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description Natural-language query. If present, runs semantic search; otherwise lists by recency. */
                        query?: string;
                        /** @description Filter to a single agent. Omit for all. */
                        agentId?: string;
                        /**
                         * @default all
                         * @enum {string}
                         */
                        scope?: "agent" | "swarm" | "all";
                        /** @enum {string} */
                        source?: "manual" | "file_index" | "session_summary" | "task_completion";
                        /** @description Substring match against sourcePath (case-insensitive). Useful for file_index memories. */
                        sourcePath?: string;
                        /** @default 20 */
                        limit?: number;
                        /** @default 0 */
                        offset?: number;
                    };
                };
            };
            responses: {
                /** @description Memory list / search results */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            results: {
                                id: string;
                                name: string;
                                content: string;
                                agentId: string | null;
                                /** @enum {string} */
                                scope: "agent" | "swarm";
                                /** @enum {string} */
                                source: "manual" | "file_index" | "session_summary" | "task_completion";
                                similarity?: number;
                                rawSimilarity?: number;
                                compositeScore?: number;
                                /** @enum {string} */
                                retrievalSource?: "vec" | "fts" | "hybrid" | "fallback" | "graph";
                                createdAt: string;
                                accessedAt: string;
                                accessCount: number;
                                expiresAt: string | null;
                                embeddingModel: string | null;
                                sourceTaskId: string | null;
                                sourcePath: string | null;
                                chunkIndex: number;
                                totalChunks: number;
                                tags: string[];
                            }[];
                            total: number;
                            limit: number;
                            offset: number;
                            /** @enum {string} */
                            mode: "semantic" | "list";
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/memory/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Report memory vector index health and retrieval mode */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Memory vector index health */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            sqliteVec: {
                                extensionLoaded: boolean;
                                tableExists: boolean;
                                initialized: boolean;
                                vectorDimensions: number;
                                /** @enum {string} */
                                distanceMetric: "cosine";
                                schema: string | null;
                                lastPopulate: {
                                    attempted: number;
                                    inserted: number;
                                    skippedInvalidDimensions: number;
                                    failed: number;
                                    beforeCount: number;
                                    afterCount: number;
                                } | null;
                            };
                            counts: {
                                total: number;
                                withEmbedding: number;
                                validEmbedding: number;
                                invalidEmbedding: number;
                                searchable: number;
                                memoryVec: number;
                                missingFromVec: number;
                                extraInVec: number;
                            };
                            /** @enum {string} */
                            retrievalMode: "vec" | "fallback";
                            reasons: string[];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/memory/usefulness": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Windowed memory usefulness analytics: retrieval volume, per-arm breakdown, citation rate per source, posterior movement */
        get: {
            parameters: {
                query?: {
                    /** @description Analysis window in days (default 30) */
                    days?: number;
                    /** @description Posterior-mean threshold for the aboveThreshold count (default 0.6) */
                    threshold?: number | null;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Usefulness stats for the window */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            windowDays: number;
                            threshold: number;
                            cutoff: string;
                            volume: {
                                retrievals: number;
                                distinctMemories: number;
                                retrievalGroups: number;
                                byEventType: {
                                    search: number;
                                    get: number;
                                };
                            };
                            byArm: {
                                retrievalSource: string | null;
                                retrievals: number;
                                distinctMemories: number;
                                citedRetrievals: number;
                                citationRate: number;
                            }[];
                            citationBySource: {
                                source: string;
                                ratings: number;
                                positive: number;
                                citationRate: number;
                                avgSignal: number;
                            }[];
                            posterior: {
                                totalMemories: number;
                                movedFromPrior: number;
                                avgPosteriorMean: number | null;
                                avgPosteriorMeanMoved: number | null;
                                aboveThreshold: number;
                            };
                            sanity: {
                                totalRetrievalRows: number;
                                totalRatingRows: number;
                                ratingsBySource: {
                                    source: string;
                                    count: number;
                                }[];
                            };
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/memory/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a single memory by ID */
        get: {
            parameters: {
                query?: {
                    /** @description Why you are retrieving this memory. Required for agent recall-edge tracking; omit for UI browse calls. */
                    intent?: string;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Memory details, plus `links` (outgoing memory_link rows; memory-kind targets carry `resolved` + ACL-filtered `target` metadata) and `backlinks` (inbound links from other memories, ACL-filtered) */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            memory: components["schemas"]["AgentMemory"];
                            links: {
                                id: string;
                                /** @enum {string} */
                                linkType: "wikilink" | "sequel" | "agent-fs-file" | "agent-ui" | "pr" | "external-source";
                                /** @enum {string} */
                                targetKind: "memory" | "agent-fs-file" | "agent-ui" | "pr" | "external-source";
                                targetId: string;
                                strength: number;
                                resolver: string;
                                sourceText: string | null;
                                createdAt: string;
                                resolved: boolean;
                                target?: {
                                    id: string;
                                    name: string;
                                    scope: string;
                                };
                            }[];
                            backlinks: {
                                id: string;
                                /** @enum {string} */
                                linkType: "wikilink" | "sequel" | "agent-fs-file" | "agent-ui" | "pr" | "external-source";
                                strength: number;
                                sourceText: string | null;
                                createdAt: string;
                                from: {
                                    id: string;
                                    name: string;
                                    scope: string;
                                };
                            }[];
                        };
                    };
                };
                /** @description Memory not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        /** Delete a single memory by ID (debug/admin) */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Memory deleted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            deleted: boolean;
                        };
                    };
                };
                /** @description Memory not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/memory/rate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Submit RatingEvents to update memory usefulness posteriors */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        events: {
                            memoryId: string;
                            signal: number;
                            weight: number;
                            /** @enum {string} */
                            source: "llm" | "explicit-self";
                            reasoning?: string;
                            /** Format: uuid */
                            taskId?: string;
                            /** @description Optional external source ID this memory references. Free-form string, convention "<source>:<identifier>" (e.g. "github:owner/repo#N", "linear:KEY-N", "customer:<slug>", "slack:<channel>:<ts>", "agentmail:<thread-id>"). Pick any prefix that fits — no closed enum. When present, an edge from this memory to the external source is created/updated. */
                            referencesSource?: string;
                        }[];
                    };
                };
            };
            responses: {
                /** @description Ratings applied; per-event rejections returned in body */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            applied: number;
                            rejected: {
                                memoryId: string;
                                reason: string;
                            }[];
                        };
                    };
                };
                /** @description Validation error or explicit-self R6 spam-guard rejection */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Duplicate explicit-self rating for (taskId, memoryId) */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/memory/retrievals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List memories retrieved for a task or session (rater input) */
        get: {
            parameters: {
                query?: {
                    taskId?: string;
                    sessionId?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Retrieval rows joined with agent_memory */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            results: {
                                id: string;
                                name: string;
                                content: string;
                                scope: string;
                                source: string;
                                scheduleId: string | null;
                                similarity: number | null;
                                retrievalSource: string | null;
                                retrievedAt: string;
                            }[];
                        };
                    };
                };
                /** @description Missing taskId/sessionId or X-Agent-ID */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/memory/edges": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List references-source edges for a memory */
        get: {
            parameters: {
                query: {
                    memoryId: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Edges with computed usefulness scores */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            edges: {
                                to: string;
                                /** @enum {string} */
                                type: "references-source";
                                alpha: number;
                                beta: number;
                                usefulness: number;
                                createdAt: string;
                            }[];
                        };
                    };
                };
                /** @description Missing memoryId or X-Agent-ID */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/metrics/definitions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List metric definitions */
        get: {
            parameters: {
                query?: {
                    agentId?: string;
                    limit?: number;
                    offset?: number | null;
                    fields?: "full" | "slim";
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Metric definitions */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            metrics: (components["schemas"]["Metric"] | {
                                id: string;
                                agentId: string;
                                slug: string;
                                title: string;
                                description?: string;
                                createdAt: string;
                                updatedAt: string;
                            })[];
                            total: number;
                            limit: number;
                            offset: number;
                        };
                    };
                };
            };
        };
        put?: never;
        /** Create a metric definition */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        slug?: string;
                        title: string;
                        description?: string | null;
                        definition: components["schemas"]["MetricDefinition"];
                    };
                };
            };
            responses: {
                /** @description Metric created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            id: string;
                            version: number;
                        };
                    };
                };
                /** @description Invalid metric definition */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Slug already exists for this agent */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/metrics/definitions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a metric definition */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Metric definition */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Metric"];
                    };
                };
                /** @description Metric not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        /** Update a metric definition */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        slug?: string;
                        title?: string;
                        description?: string | null;
                        definition?: components["schemas"]["MetricDefinition"];
                    };
                };
            };
            responses: {
                /** @description Metric updated */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            id: string;
                            version: number;
                        };
                    };
                };
                /** @description Metric not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        post?: never;
        /** Delete a metric definition */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Metric deleted */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Metric not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/metrics/definitions/{id}/run": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Run a metric definition */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        variables?: {
                            [key: string]: string | number | boolean | null;
                        };
                    };
                };
            };
            responses: {
                /** @description Metric result */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            metric: components["schemas"]["Metric"];
                            variables: {
                                [key: string]: string | number | boolean | null;
                            };
                            widgets: {
                                widget: components["schemas"]["MetricWidget"];
                                result: {
                                    columns: string[];
                                    rows: {
                                        [key: string]: unknown;
                                    }[];
                                    elapsed: number;
                                    total: number;
                                    truncated: boolean;
                                    maxRows: number;
                                };
                            }[];
                            result?: {
                                columns: string[];
                                rows: {
                                    [key: string]: unknown;
                                }[];
                                elapsed: number;
                                total: number;
                                truncated: boolean;
                                maxRows: number;
                            };
                        };
                    };
                };
                /** @description Invalid or disallowed query */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Metric not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/metrics/definitions/{id}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List metric definition versions */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Metric version list */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            versions: components["schemas"]["MetricVersion"][];
                        };
                    };
                };
                /** @description Metric not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/metrics/definitions/{id}/versions/{version}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a metric definition version */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    version: number;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Metric version */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["MetricVersion"];
                    };
                };
                /** @description Metric or version not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/metrics/schema": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get the metric definition JSON Schema */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Metric definition JSON Schema */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            schema: {
                                [key: string]: unknown;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/models-catalog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get the live model catalog for the picker-reachable providers
         * @description Slim projection of the models.dev payload (openrouter / anthropic / openai / amazon-bedrock only), refreshed server-side at boot and every 12h by the pricing-refresh loop. `source` is 'snapshot' with `updatedAt: null` until the first successful fetch (or when models.dev is unreachable), in which case the vendored snapshot is served instead.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Model catalog */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            source: "live" | "snapshot";
                            updatedAt: number | null;
                            providers: {
                                [key: string]: {
                                    id: string;
                                    name?: string;
                                    models: {
                                        [key: string]: {
                                            id: string;
                                            name?: string;
                                            cost?: {
                                                input?: number;
                                                output?: number;
                                            };
                                            limit?: {
                                                context?: number;
                                            };
                                            reasoning?: boolean;
                                            reasoning_options?: {
                                                type: string;
                                                values?: string[];
                                            }[];
                                        };
                                    };
                                };
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/oauth/refresh-locks/{key}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Acquire a cross-process OAuth refresh lock */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    key: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        ttlMs: number;
                    };
                };
            };
            responses: {
                /** @description Lock acquired; returns the owner token */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            owner: string;
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Lock is currently held by another caller */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        /** Release a cross-process OAuth refresh lock if still held by the given owner */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    key: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        owner: string;
                    };
                };
            };
            responses: {
                /** @description Released (a mismatched/expired owner is a no-op, also 204) */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/mcp-oauth/{mcpServerId}/metadata": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Probe OAuth metadata (PRMD + AS) for an MCP server */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    mcpServerId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OAuth metadata or { requiresOAuth: false } */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            requiresOAuth: false;
                        } | {
                            resourceUrl: string;
                            authorizationServerIssuer: string;
                            authorizeUrl: string;
                            tokenUrl: string;
                            revocationUrl: string | null;
                            registrationEndpoint: string | null;
                            scopes: string[];
                            /** @enum {boolean} */
                            requiresOAuth: true;
                            dcrSupported: boolean;
                            bearerMethodsSupported: string[] | null;
                        };
                    };
                };
                /** @description MCP has no URL / invalid transport */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description MCP server not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/mcp-oauth/{mcpServerId}/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get the current OAuth connection status for an MCP server */
        get: {
            parameters: {
                query?: {
                    userId?: string;
                };
                header?: never;
                path: {
                    mcpServerId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Token status (never includes the token value itself) */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            mcpServerId: string;
                            /** @enum {string} */
                            authMethod: "static" | "oauth" | "auto";
                            connected: boolean;
                            token: {
                                id: string;
                                /** @enum {string} */
                                status: "connected" | "expired" | "error" | "revoked";
                                tokenType: string;
                                expiresAt: string | null;
                                scope: string | null;
                                lastErrorMessage: string | null;
                                lastRefreshedAt: string | null;
                                authorizationServerIssuer: string;
                                resourceUrl: string;
                                /** @enum {string} */
                                clientSource: "dcr" | "manual" | "preregistered";
                                hasRefreshToken: boolean;
                                createdAt: string;
                                updatedAt: string;
                            } | null;
                        };
                    };
                };
                /** @description MCP server not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/mcp-oauth/{mcpServerId}/authorize": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Start an OAuth flow. Redirects to the provider. */
        get: {
            parameters: {
                query?: {
                    redirect?: string;
                    userId?: string;
                    scopes?: string;
                };
                header?: never;
                path: {
                    mcpServerId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Redirect to authorization server */
                302: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description MCP has no URL / does not require OAuth */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description MCP server not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/mcp-oauth/{mcpServerId}/authorize-url": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Build an OAuth authorize URL. Returns JSON so the browser can navigate without losing the Bearer auth header. */
        get: {
            parameters: {
                query?: {
                    redirect?: string;
                    userId?: string;
                    scopes?: string;
                };
                header?: never;
                path: {
                    mcpServerId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description { providerUrl: string } */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            providerUrl: string;
                        };
                    };
                };
                /** @description MCP has no URL / does not require OAuth */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description MCP server not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/mcp-oauth/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** OAuth redirect target. Exchanges code -> tokens and redirects back to dashboard. */
        get: {
            parameters: {
                query?: {
                    code?: string;
                    state?: string;
                    error?: string;
                    error_description?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Redirect back to dashboard with oauth=success or oauth=error */
                302: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Bad state / missing code */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/mcp-oauth/{mcpServerId}/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Force-refresh the access token for an MCP server */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    mcpServerId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        userId?: string;
                    };
                };
            };
            responses: {
                /** @description Refreshed token */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            ok: true;
                            expiresAt: string | null;
                            scope: string | null;
                        };
                    };
                };
                /** @description No token for this MCP server */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Refresh failed */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/mcp-oauth/{mcpServerId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Revoke and delete the OAuth token for an MCP server */
        delete: {
            parameters: {
                query?: {
                    userId?: string;
                };
                header?: never;
                path: {
                    mcpServerId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Token revoked/deleted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            ok: true;
                        };
                    };
                };
                /** @description No token for this MCP server */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/mcp-oauth/{mcpServerId}/manual-client": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Register a pre-existing OAuth client (DCR fallback) */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    mcpServerId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        clientId: string;
                        clientSecret?: string;
                        /** Format: uri */
                        authorizationServerIssuer?: string;
                        /** Format: uri */
                        authorizeUrl?: string;
                        /** Format: uri */
                        tokenUrl?: string;
                        /** Format: uri */
                        revocationUrl?: string;
                        scopes?: string[];
                    };
                };
            };
            responses: {
                /** @description Pending client stored. Call /authorize to start the flow. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            ok: true;
                        };
                    };
                };
                /** @description Bad input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description MCP server not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/oauth/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Single static OAuth redirect target (state-keyed, all flows) */
        get: operations["oauth_static_callback"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/oauth/redirect-uri": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The static OAuth callback URL to register with providers (pre-creation display) */
        get: operations["oauth_redirect_uri"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/oauth/{provider}/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Legacy per-provider OAuth redirect target (delegates to the static callback) */
        get: operations["oauth_generic_callback"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/@swarm/api/{path}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Cookie-gated proxy to the swarm API (used by db-backed page iframes) */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Proxied response from the underlying /api/* endpoint */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description No or invalid page-session cookie */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Page referenced by the cookie no longer exists */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        /** Cookie-gated proxy to the swarm API (PUT) */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Proxied response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description No or invalid page-session cookie */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        /** Cookie-gated proxy to the swarm API (POST) */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Proxied response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description No or invalid page-session cookie */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        /** Cookie-gated proxy to the swarm API (DELETE) */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Proxied response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description No or invalid page-session cookie */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        /** Cookie-gated proxy to the swarm API (PATCH) */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Proxied response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description No or invalid page-session cookie */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/pages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List pages
         * @description Returns pages WITHOUT the heavy `body` (the full HTML/JSON document) and `passwordHash` by default — list views never render the body. Pass `fields=full` to restore `body`. Fetch a full page via `GET /api/pages/{id}`.
         */
        get: {
            parameters: {
                query?: {
                    agentId?: string;
                    /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                    key?: string;
                    /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                    keyPrefix?: string;
                    limit?: number;
                    offset?: number | null;
                    fields?: "full" | "slim";
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Page list with totals + share-URL pointers */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            pages: {
                                id: string;
                                /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                                key: string;
                                agentId: string;
                                slug: string;
                                title: string;
                                description?: string;
                                /** @enum {string} */
                                contentType: "text/html" | "application/json";
                                /** @enum {string} */
                                authMode: "public" | "authed" | "password";
                                passwordHash?: string;
                                body?: string;
                                needsCredentials?: string[];
                                /** @default 0 */
                                viewCount: number;
                                createdAt: string;
                                updatedAt: string;
                                favorite: boolean;
                                api_url: string;
                                app_url: string;
                            }[];
                            total: number;
                            limit: number;
                            offset: number;
                        };
                    };
                };
            };
        };
        put?: never;
        /** Create a new page */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                        key?: string;
                        slug?: string;
                        title: string;
                        description?: string;
                        /** @enum {string} */
                        contentType: "text/html" | "application/json";
                        /**
                         * @default authed
                         * @enum {string}
                         */
                        authMode?: "public" | "authed" | "password";
                        password?: string;
                        body: string;
                        needsCredentials?: string[];
                    };
                };
            };
            responses: {
                /** @description Page created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            id: string;
                            /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                            key: string;
                            /** @enum {number} */
                            version: 1;
                            api_url: string;
                            app_url: string;
                        };
                    };
                };
                /** @description Invalid body */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Slug already exists for this agent */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/pages/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a page by ID */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Page row */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Page"] & {
                            api_url: string;
                            app_url: string;
                        };
                    };
                };
                /** @description Page not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        /** Update an existing page */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                        key?: string;
                        title?: string;
                        description?: string | null;
                        /** @enum {string} */
                        contentType?: "text/html" | "application/json";
                        /** @enum {string} */
                        authMode?: "public" | "authed" | "password";
                        password?: string | null;
                        body?: string;
                        needsCredentials?: string[] | null;
                    };
                };
            };
            responses: {
                /** @description Page updated */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            id: string;
                            /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                            key: string;
                            version: number;
                        };
                    };
                };
                /** @description Page not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Payload too large */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        post?: never;
        /** Delete a page (and all version history) */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Page deleted */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Page not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/pages/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Resolve a page by slug */
        get: {
            parameters: {
                query: {
                    slug: string;
                    agentId?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Resolved page row */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Page"] & {
                            api_url: string;
                            app_url: string;
                        };
                    };
                };
                /** @description Page not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/pages/{id}/launch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Launch a page session (issues HttpOnly cookie) */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Cookie issued */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Launch not supported for this page (e.g. password mode) */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Page not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/pages/actions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List JSON-page action allowlist (with param JSON Schemas) */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Action allowlist */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            actions: {
                                name: string;
                                description: string;
                                params: {
                                    [key: string]: unknown;
                                };
                                sdkMethods?: string[];
                            }[];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/pages/{id}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List version snapshots for a page */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Version list (newest first) */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            versions: components["schemas"]["PageVersion"][];
                        };
                    };
                };
                /** @description Page not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/pages/{id}/versions/{version}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a single page-version snapshot */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    version: number;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Version snapshot */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PageVersion"];
                    };
                };
                /** @description Page or version not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/p/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Render a page (HTML inline; JSON redirects to SPA) */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Rendered HTML page */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Redirect to SPA for JSON content */
                302: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Page requires an authenticated session */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Cookie does not match this page id */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Page not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/p/{id}.json": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Page metadata + body as JSON (used by SPA renderer) */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Page JSON */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            id: string;
                            title: string;
                            description?: string;
                            /** @enum {string} */
                            contentType: "text/html" | "application/json";
                            /** @enum {string} */
                            authMode: "public" | "authed" | "password";
                            body: string;
                            /** @enum {number} */
                            version: 1;
                        };
                    };
                };
                /** @description Page requires an authenticated session */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Cookie does not match this page id */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Page not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/prompt-templates/resolved": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Resolve a prompt template for a given event type and scope chain */
        get: {
            parameters: {
                query: {
                    eventType: string;
                    agentId?: string;
                    repoId?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Resolved template info */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            resolution: {
                                text: string;
                                templateId?: string;
                                scope?: string;
                                skipped: boolean;
                                unresolved: string[];
                            };
                            dbResult: {
                                template: components["schemas"]["PromptTemplate"];
                            } | {
                                /** @enum {boolean} */
                                skip: true;
                            } | null;
                            definition: {
                                eventType: string;
                                header: string;
                                defaultBody: string;
                                variables: {
                                    name: string;
                                    description: string;
                                    example?: string;
                                }[];
                                /** @enum {string} */
                                category: "event" | "system" | "common" | "task_lifecycle" | "session";
                            } | null;
                        };
                    };
                };
                /** @description Missing eventType */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/prompt-templates/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List all registered event types with their available variables */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description List of event template definitions */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            events: {
                                eventType: string;
                                header: string;
                                defaultBody: string;
                                variables: {
                                    name: string;
                                    description: string;
                                    example?: string;
                                }[];
                                /** @enum {string} */
                                category: "event" | "system" | "common" | "task_lifecycle" | "session";
                            }[];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/prompt-templates/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Dry-run render a template with provided variables */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        eventType: string;
                        body?: string;
                        variables?: {
                            [key: string]: unknown;
                        };
                    };
                };
            };
            responses: {
                /** @description Rendered template preview */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            rendered: string;
                            unresolved: string[];
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/prompt-templates/render": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Full scope-aware template resolution with interpolation (used by workers via HTTP) */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        eventType: string;
                        variables?: {
                            [key: string]: unknown;
                        };
                        agentId?: string;
                        repoId?: string;
                    };
                };
            };
            responses: {
                /** @description Fully resolved and interpolated template */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            text: string;
                            templateId?: string;
                            scope?: string;
                            skipped: boolean;
                            unresolved: string[];
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/prompt-templates/{id}/checkout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Checkout a specific version of a prompt template from history */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        version: number;
                    };
                };
            };
            responses: {
                /** @description Checked-out template */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            template: components["schemas"]["PromptTemplate"];
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Template or version not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/prompt-templates/{id}/reset": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Reset a prompt template to its code-defined default */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Reset template */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            template: components["schemas"]["PromptTemplate"];
                        };
                    };
                };
                /** @description Template not found or no code default available */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/prompt-templates/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a single prompt template with its version history */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Template with history */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            template: components["schemas"]["PromptTemplate"];
                            history: components["schemas"]["PromptTemplateHistory"][];
                        };
                    };
                };
                /** @description Template not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        /** Delete a prompt template override */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Template deleted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            deleted: true;
                        };
                    };
                };
                /** @description Cannot delete default template */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Template not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/prompt-templates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List prompt templates with optional filters */
        get: {
            parameters: {
                query?: {
                    eventType?: string;
                    scope?: string;
                    scopeId?: string;
                    isDefault?: "true" | "false";
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description List of prompt templates */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            templates: components["schemas"]["PromptTemplate"][];
                        };
                    };
                };
            };
        };
        /** Create or update a prompt template override */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        eventType: string;
                        /** @enum {string} */
                        scope?: "global" | "agent" | "repo";
                        scopeId?: string;
                        /** @enum {string} */
                        state?: "enabled" | "default_prompt_fallback" | "skip_event";
                        body: string;
                        changedBy?: string;
                        changeReason?: string;
                    };
                };
            };
            responses: {
                /** @description Upserted template */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            template: components["schemas"]["PromptTemplate"];
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/poll": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Poll for triggers (tasks, mentions) */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Trigger data or null */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            trigger: {
                                /** @enum {string} */
                                type: "task_offered";
                                taskId: string;
                                task: components["schemas"]["AgentTask"];
                            } | {
                                /** @enum {string} */
                                type: "task_assigned";
                                taskId: string;
                                task: components["schemas"]["AgentTask"] & {
                                    attachments: {
                                        /** Format: uuid */
                                        id: string;
                                        name: string;
                                        mimeType?: string;
                                        sizeBytes?: number;
                                    }[];
                                };
                                requestedBy?: {
                                    name: string;
                                    email?: string;
                                    role?: string;
                                    notes?: string;
                                };
                            } | components["schemas"]["BudgetRefusedTrigger"] | {
                                /** @enum {string} */
                                type: "unread_mentions";
                                mentionsCount: number;
                                claimedChannels: string[];
                            } | {
                                /** @enum {string} */
                                type: "channel_activity";
                                count: number;
                                messages: {
                                    channelId: string;
                                    channelName?: string;
                                    ts: string;
                                    user: string;
                                    text: string;
                                }[];
                                cursorUpdates: {
                                    channelId: string;
                                    ts: string;
                                }[];
                            } | null;
                        };
                    };
                };
                /** @description Missing X-Agent-ID */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Agent not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/channel-activity/commit-cursors": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Commit channel activity cursors after successful processing */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        cursorUpdates: {
                            channelId: string;
                            ts: string;
                        }[];
                    };
                };
            };
            responses: {
                /** @description Cursors committed */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                            committed: number;
                        };
                    };
                };
                /** @description Invalid request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/pricing": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List every pricing row across all providers */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Pricing rows */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            rows: components["schemas"]["PricingRow"][];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/pricing/{provider}/{model}/{tokenClass}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List pricing history for a (provider, model, tokenClass) triple */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    provider: "claude" | "claude-managed" | "codex" | "pi" | "opencode" | "devin" | "gemini";
                    model: string;
                    tokenClass: "input" | "cached_input" | "output" | "cache_write" | "cache_write_1h" | "web_search" | "runtime_hour" | "acu";
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Pricing rows (latest first) */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            rows: components["schemas"]["PricingRow"][];
                        };
                    };
                };
            };
        };
        put?: never;
        /** Append a new pricing row */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    provider: "claude" | "claude-managed" | "codex" | "pi" | "opencode" | "devin" | "gemini";
                    model: string;
                    tokenClass: "input" | "cached_input" | "output" | "cache_write" | "cache_write_1h" | "web_search" | "runtime_hour" | "acu";
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        pricePerMillionUsd: number;
                        effectiveFrom?: number;
                    };
                };
            };
            responses: {
                /** @description Pricing row inserted */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PricingRow"];
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Duplicate (provider, model, tokenClass, effectiveFrom) */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/pricing/{provider}/{model}/{tokenClass}/active": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get the currently active pricing row */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    provider: "claude" | "claude-managed" | "codex" | "pi" | "opencode" | "devin" | "gemini";
                    model: string;
                    tokenClass: "input" | "cached_input" | "output" | "cache_write" | "cache_write_1h" | "web_search" | "runtime_hour" | "acu";
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Active pricing row */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["PricingRow"];
                    };
                };
                /** @description No pricing row in effect */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/pricing/{provider}/{model}/{tokenClass}/{effectiveFrom}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete a pricing row (typo correction) */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    provider: "claude" | "claude-managed" | "codex" | "pi" | "opencode" | "devin" | "gemini";
                    model: string;
                    tokenClass: "input" | "cached_input" | "output" | "cache_write" | "cache_write_1h" | "web_search" | "runtime_hour" | "acu";
                    effectiveFrom: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Pricing row deleted */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pricing row not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/repos/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a repo by ID */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Repo details */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwarmRepo"];
                    };
                };
                /** @description Repo not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: string;
                        };
                    };
                };
            };
        };
        /** Update a repo */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        url?: string;
                        name?: string;
                        clonePath?: string;
                        defaultBranch?: string;
                        autoClone?: boolean;
                        hooks?: components["schemas"]["RepoHooks"] | null;
                        guidelines?: components["schemas"]["RepoGuidelines"];
                    };
                };
            };
            responses: {
                /** @description Repo updated */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwarmRepo"];
                    };
                };
                /** @description Repo not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: string;
                        };
                    };
                };
                /** @description Duplicate repo */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: string;
                        };
                    };
                };
            };
        };
        post?: never;
        /** Delete a repo */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Repo deleted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            success: boolean;
                        };
                    };
                };
                /** @description Repo not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: string;
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/repos": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List repos with optional filters */
        get: {
            parameters: {
                query?: {
                    autoClone?: "true" | "false";
                    name?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description List of repos */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            repos: components["schemas"]["SwarmRepo"][];
                        };
                    };
                };
            };
        };
        put?: never;
        /** Create a new repo */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        url: string;
                        name: string;
                        clonePath?: string;
                        defaultBranch?: string;
                        autoClone?: boolean;
                        hooks?: components["schemas"]["RepoHooks"];
                        guidelines?: components["schemas"]["RepoGuidelines"];
                    };
                };
            };
            responses: {
                /** @description Repo created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SwarmRepo"];
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: string;
                        };
                    };
                };
                /** @description Duplicate repo */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/schedules": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List schedules
         * @description Returns schedules with the full `taskTemplate` replaced by a short `taskTemplatePreview` by default — list views never render the full template. Pass `fields=full` to restore `taskTemplate`. Fetch the full template via `GET /api/schedules/{id}`.
         */
        get: {
            parameters: {
                query?: {
                    enabled?: "true" | "false";
                    name?: string;
                    scheduleType?: "recurring" | "one_time";
                    targetType?: "agent-task" | "workflow" | "script";
                    workflowId?: string;
                    scriptName?: string;
                    hideCompleted?: "true" | "false";
                    consecutiveErrorsMin?: number | null;
                    lastRunStatus?: "failed" | "succeeded";
                    fields?: "full" | "slim";
                    /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                    key?: string;
                    /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                    keyPrefix?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description List of schedules */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            schedules: {
                                /** Format: uuid */
                                id: string;
                                /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                                key: string;
                                name: string;
                                description?: string;
                                cronExpression?: string;
                                intervalMs?: number;
                                taskType?: string;
                                /** @default [] */
                                tags: string[];
                                /** @default 50 */
                                priority: number;
                                targetAgentId?: string;
                                /** @default true */
                                enabled: boolean;
                                /** Format: date-time */
                                lastRunAt?: string;
                                /** Format: date-time */
                                nextRunAt?: string;
                                createdByAgentId?: string;
                                /** @default UTC */
                                timezone: string;
                                /** @default 0 */
                                consecutiveErrors: number;
                                /** Format: date-time */
                                lastErrorAt?: string;
                                lastErrorMessage?: string;
                                model?: string;
                                /** @enum {string} */
                                modelTier?: "smol" | "regular" | "smart" | "ultra";
                                /**
                                 * @default recurring
                                 * @enum {string}
                                 */
                                scheduleType: "recurring" | "one_time";
                                /**
                                 * @default agent-task
                                 * @enum {string}
                                 */
                                targetType: "agent-task" | "workflow" | "script";
                                /** Format: uuid */
                                workflowId?: string;
                                scriptName?: string;
                                scriptArgs?: {
                                    [key: string]: unknown;
                                };
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: date-time */
                                lastUpdatedAt: string;
                                createdBy?: string;
                                updatedBy?: string;
                                favorite: boolean;
                                taskTemplatePreview: string;
                            }[] | {
                                /** Format: uuid */
                                id: string;
                                /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                                key: string;
                                name: string;
                                description?: string;
                                cronExpression?: string;
                                intervalMs?: number;
                                taskTemplate?: string;
                                taskType?: string;
                                /** @default [] */
                                tags: string[];
                                /** @default 50 */
                                priority: number;
                                targetAgentId?: string;
                                /** @default true */
                                enabled: boolean;
                                /** Format: date-time */
                                lastRunAt?: string;
                                /** Format: date-time */
                                nextRunAt?: string;
                                createdByAgentId?: string;
                                /** @default UTC */
                                timezone: string;
                                /** @default 0 */
                                consecutiveErrors: number;
                                /** Format: date-time */
                                lastErrorAt?: string;
                                lastErrorMessage?: string;
                                model?: string;
                                /** @enum {string} */
                                modelTier?: "smol" | "regular" | "smart" | "ultra";
                                /**
                                 * @default recurring
                                 * @enum {string}
                                 */
                                scheduleType: "recurring" | "one_time";
                                /**
                                 * @default agent-task
                                 * @enum {string}
                                 */
                                targetType: "agent-task" | "workflow" | "script";
                                /** Format: uuid */
                                workflowId?: string;
                                scriptName?: string;
                                scriptArgs?: {
                                    [key: string]: unknown;
                                };
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: date-time */
                                lastUpdatedAt: string;
                                createdBy?: string;
                                updatedBy?: string;
                                favorite: boolean;
                            }[];
                            count: number;
                        };
                    };
                };
            };
        };
        put?: never;
        /** Create a new schedule */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                        key?: string;
                        name: string;
                        description?: string;
                        cronExpression?: string;
                        intervalMs?: number;
                        taskTemplate?: string;
                        taskType?: string;
                        tags?: string[];
                        priority?: number;
                        targetAgentId?: string;
                        enabled?: boolean;
                        timezone?: string;
                        model?: string;
                        /** @enum {string} */
                        modelTier?: "smol" | "regular" | "smart" | "ultra";
                        /** @enum {string} */
                        scheduleType?: "recurring" | "one_time";
                        /** @enum {string} */
                        targetType?: "agent-task" | "workflow" | "script";
                        /** Format: uuid */
                        workflowId?: string;
                        scriptName?: string;
                        scriptArgs?: {
                            [key: string]: unknown;
                        };
                        delayMs?: number;
                        runAt?: string;
                    };
                };
            };
            responses: {
                /** @description Schedule created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: uuid */
                            id: string;
                            /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                            key: string;
                            name: string;
                            description?: string;
                            cronExpression?: string;
                            intervalMs?: number;
                            taskTemplate?: string;
                            taskType?: string;
                            /** @default [] */
                            tags: string[];
                            /** @default 50 */
                            priority: number;
                            targetAgentId?: string;
                            /** @default true */
                            enabled: boolean;
                            /** Format: date-time */
                            lastRunAt?: string;
                            /** Format: date-time */
                            nextRunAt?: string;
                            createdByAgentId?: string;
                            /** @default UTC */
                            timezone: string;
                            /** @default 0 */
                            consecutiveErrors: number;
                            /** Format: date-time */
                            lastErrorAt?: string;
                            lastErrorMessage?: string;
                            model?: string;
                            /** @enum {string} */
                            modelTier?: "smol" | "regular" | "smart" | "ultra";
                            /**
                             * @default recurring
                             * @enum {string}
                             */
                            scheduleType: "recurring" | "one_time";
                            /**
                             * @default agent-task
                             * @enum {string}
                             */
                            targetType: "agent-task" | "workflow" | "script";
                            /** Format: uuid */
                            workflowId?: string;
                            scriptName?: string;
                            scriptArgs?: {
                                [key: string]: unknown;
                            };
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            lastUpdatedAt: string;
                            createdBy?: string;
                            updatedBy?: string;
                            favorite?: boolean;
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Duplicate name */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/schedules/{id}/run": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Run a schedule immediately */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Schedule run triggered */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            schedule: {
                                /** Format: uuid */
                                id: string;
                                /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                                key: string;
                                name: string;
                                description?: string;
                                cronExpression?: string;
                                intervalMs?: number;
                                taskTemplate?: string;
                                taskType?: string;
                                /** @default [] */
                                tags: string[];
                                /** @default 50 */
                                priority: number;
                                targetAgentId?: string;
                                /** @default true */
                                enabled: boolean;
                                /** Format: date-time */
                                lastRunAt?: string;
                                /** Format: date-time */
                                nextRunAt?: string;
                                createdByAgentId?: string;
                                /** @default UTC */
                                timezone: string;
                                /** @default 0 */
                                consecutiveErrors: number;
                                /** Format: date-time */
                                lastErrorAt?: string;
                                lastErrorMessage?: string;
                                model?: string;
                                /** @enum {string} */
                                modelTier?: "smol" | "regular" | "smart" | "ultra";
                                /**
                                 * @default recurring
                                 * @enum {string}
                                 */
                                scheduleType: "recurring" | "one_time";
                                /**
                                 * @default agent-task
                                 * @enum {string}
                                 */
                                targetType: "agent-task" | "workflow" | "script";
                                /** Format: uuid */
                                workflowId?: string;
                                scriptName?: string;
                                scriptArgs?: {
                                    [key: string]: unknown;
                                };
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: date-time */
                                lastUpdatedAt: string;
                                createdBy?: string;
                                updatedBy?: string;
                                favorite?: boolean;
                            } | null;
                            workflowRunIds?: string[];
                            task?: components["schemas"]["AgentTask"];
                        };
                    };
                };
                /** @description Schedule is disabled */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Schedule not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/schedules/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a schedule by ID */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Schedule details */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: uuid */
                            id: string;
                            /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                            key: string;
                            name: string;
                            description?: string;
                            cronExpression?: string;
                            intervalMs?: number;
                            taskTemplate?: string;
                            taskType?: string;
                            /** @default [] */
                            tags: string[];
                            /** @default 50 */
                            priority: number;
                            targetAgentId?: string;
                            /** @default true */
                            enabled: boolean;
                            /** Format: date-time */
                            lastRunAt?: string;
                            /** Format: date-time */
                            nextRunAt?: string;
                            createdByAgentId?: string;
                            /** @default UTC */
                            timezone: string;
                            /** @default 0 */
                            consecutiveErrors: number;
                            /** Format: date-time */
                            lastErrorAt?: string;
                            lastErrorMessage?: string;
                            model?: string;
                            /** @enum {string} */
                            modelTier?: "smol" | "regular" | "smart" | "ultra";
                            /**
                             * @default recurring
                             * @enum {string}
                             */
                            scheduleType: "recurring" | "one_time";
                            /**
                             * @default agent-task
                             * @enum {string}
                             */
                            targetType: "agent-task" | "workflow" | "script";
                            /** Format: uuid */
                            workflowId?: string;
                            scriptName?: string;
                            scriptArgs?: {
                                [key: string]: unknown;
                            };
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            lastUpdatedAt: string;
                            createdBy?: string;
                            updatedBy?: string;
                            favorite?: boolean;
                        };
                    };
                };
                /** @description Schedule not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        /** Update a schedule */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                        key?: string;
                        name?: string;
                        description?: string;
                        cronExpression?: string | null;
                        intervalMs?: number | null;
                        taskTemplate?: string;
                        taskType?: string;
                        tags?: string[];
                        priority?: number;
                        targetAgentId?: string | null;
                        enabled?: boolean;
                        timezone?: string;
                        model?: string | null;
                        /** @enum {string|null} */
                        modelTier?: "smol" | "regular" | "smart" | "ultra" | null;
                        nextRunAt?: string | null;
                        /** @enum {string} */
                        targetType?: "agent-task" | "workflow" | "script";
                        /** Format: uuid */
                        workflowId?: string | null;
                        scriptName?: string | null;
                        scriptArgs?: {
                            [key: string]: unknown;
                        } | null;
                    };
                };
            };
            responses: {
                /** @description Schedule updated */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: uuid */
                            id: string;
                            /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                            key: string;
                            name: string;
                            description?: string;
                            cronExpression?: string;
                            intervalMs?: number;
                            taskTemplate?: string;
                            taskType?: string;
                            /** @default [] */
                            tags: string[];
                            /** @default 50 */
                            priority: number;
                            targetAgentId?: string;
                            /** @default true */
                            enabled: boolean;
                            /** Format: date-time */
                            lastRunAt?: string;
                            /** Format: date-time */
                            nextRunAt?: string;
                            createdByAgentId?: string;
                            /** @default UTC */
                            timezone: string;
                            /** @default 0 */
                            consecutiveErrors: number;
                            /** Format: date-time */
                            lastErrorAt?: string;
                            lastErrorMessage?: string;
                            model?: string;
                            /** @enum {string} */
                            modelTier?: "smol" | "regular" | "smart" | "ultra";
                            /**
                             * @default recurring
                             * @enum {string}
                             */
                            scheduleType: "recurring" | "one_time";
                            /**
                             * @default agent-task
                             * @enum {string}
                             */
                            targetType: "agent-task" | "workflow" | "script";
                            /** Format: uuid */
                            workflowId?: string;
                            scriptName?: string;
                            scriptArgs?: {
                                [key: string]: unknown;
                            };
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            lastUpdatedAt: string;
                            createdBy?: string;
                            updatedBy?: string;
                            favorite?: boolean;
                        } | null;
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Schedule not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Duplicate name */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        post?: never;
        /** Delete a schedule */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Schedule deleted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                        };
                    };
                };
                /** @description Schedule not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        /**
         * Patch a schedule
         * @description Partially updates a schedule by shallow-merging provided fields over the existing row.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                        key?: string;
                        name?: string;
                        description?: string;
                        cronExpression?: string | null;
                        intervalMs?: number | null;
                        taskTemplate?: string;
                        taskType?: string;
                        tags?: string[];
                        priority?: number;
                        targetAgentId?: string | null;
                        enabled?: boolean;
                        timezone?: string;
                        model?: string | null;
                        /** @enum {string|null} */
                        modelTier?: "smol" | "regular" | "smart" | "ultra" | null;
                        nextRunAt?: string | null;
                        /** @enum {string} */
                        targetType?: "agent-task" | "workflow" | "script";
                        /** Format: uuid */
                        workflowId?: string | null;
                        scriptName?: string | null;
                        scriptArgs?: {
                            [key: string]: unknown;
                        } | null;
                    };
                };
            };
            responses: {
                /** @description Schedule patched */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: uuid */
                            id: string;
                            /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                            key: string;
                            name: string;
                            description?: string;
                            cronExpression?: string;
                            intervalMs?: number;
                            taskTemplate?: string;
                            taskType?: string;
                            /** @default [] */
                            tags: string[];
                            /** @default 50 */
                            priority: number;
                            targetAgentId?: string;
                            /** @default true */
                            enabled: boolean;
                            /** Format: date-time */
                            lastRunAt?: string;
                            /** Format: date-time */
                            nextRunAt?: string;
                            createdByAgentId?: string;
                            /** @default UTC */
                            timezone: string;
                            /** @default 0 */
                            consecutiveErrors: number;
                            /** Format: date-time */
                            lastErrorAt?: string;
                            lastErrorMessage?: string;
                            model?: string;
                            /** @enum {string} */
                            modelTier?: "smol" | "regular" | "smart" | "ultra";
                            /**
                             * @default recurring
                             * @enum {string}
                             */
                            scheduleType: "recurring" | "one_time";
                            /**
                             * @default agent-task
                             * @enum {string}
                             */
                            targetType: "agent-task" | "workflow" | "script";
                            /** Format: uuid */
                            workflowId?: string;
                            scriptName?: string;
                            scriptArgs?: {
                                [key: string]: unknown;
                            };
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            lastUpdatedAt: string;
                            createdBy?: string;
                            updatedBy?: string;
                            favorite?: boolean;
                        } | null;
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Schedule not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Duplicate name */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/script-connections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List script connections
         * @description Dashboard read of OpenAPI, GraphQL, and MCP script connections with credential summaries.
         */
        get: operations["script_connections_list"];
        put?: never;
        /** Create or update a script connection */
        post: operations["script_connections_upsert"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/script-connections/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get script connection detail */
        get: operations["script_connections_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/script-connections/{id}/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Refresh a script connection */
        post: operations["script_connections_refresh"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/script-connections/{id}/disable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Enable or disable a script connection */
        post: operations["script_connections_set_enabled"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/credential-bindings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List standalone script credential bindings
         * @description Lists standalone (raw fetch()) credential bindings. Auto-managed bindings that back embedded connection auth are hidden by default; pass includeManaged=true to include them.
         */
        get: operations["credential_bindings_list"];
        put?: never;
        /** Create or update a script credential binding */
        post: operations["credential_bindings_upsert"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/oauth-apps": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List OAuth apps for script credential bindings */
        get: operations["oauth_apps_list"];
        put?: never;
        /** Create or update an OAuth app for script credential bindings */
        post: operations["oauth_apps_upsert"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/oauth-presets": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List curated OAuth presets for app-creation pickers
         * @description Static curated OAuth presets (endpoints, scopes, quirks, and setup hints). Contains no secrets; client credentials are always customer-supplied.
         */
        get: operations["oauth_presets_list"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/oauth-apps/discover": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Discover OAuth endpoints from provider metadata */
        post: operations["oauth_apps_discover"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/oauth-apps/{provider}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete an OAuth app and its tokens */
        delete: operations["oauth_apps_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/oauth-apps/{id}/authorize-url": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Build an OAuth authorization URL for a labeled authorization */
        post: operations["oauth_apps_authorize_url"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/oauth-apps/{id}/authorizations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the labeled authorizations for an OAuth app (never token material) */
        get: operations["oauth_app_authorizations_list"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/oauth-authorizations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Revoke (best-effort) and delete a single OAuth authorization */
        delete: operations["oauth_authorization_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/oauth-authorizations/{id}/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Force-refresh a single OAuth authorization (never returns token values) */
        post: operations["oauth_authorization_refresh"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations-catalog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Proxy integrations.sh catalog entries */
        get: operations["integrations_catalog_list"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations-catalog/{domain}/surface": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Proxy integrations.sh per-domain surface details (trimmed for the Add Connection flow) */
        get: operations["integrations_catalog_surface"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/oauth-apps/{provider}/tokens": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Disconnect an OAuth app: delete stored tokens (best-effort remote revocation when a revocation endpoint is known) */
        delete: operations["oauth_app_disconnect"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/oauth-apps/{provider}/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Force-refresh the stored OAuth tokens for a provider (never returns token values) */
        post: operations["oauth_app_refresh_tokens"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/script-runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List script workflow runs */
        get: operations["script_runs_list"];
        put?: never;
        /**
         * Launch a durable script workflow run
         * @description Foundation endpoint for Script Workflows v1. In PR 1 it persists the run and returns its dashboard URL; spawning is added by the supervisor PR.
         */
        post: operations["script_runs_create"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/script-runs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a script workflow run with journal */
        get: operations["script_runs_get"];
        put?: never;
        post?: never;
        /** Cancel a script workflow run */
        delete: operations["script_runs_cancel"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/internal/script-runs/{runId}/steps/{stepKey}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a script run journal step */
        get: operations["script_runs_internal_step_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/internal/script-runs/{runId}/steps": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Write a script run journal step */
        post: operations["script_runs_internal_step_create"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/internal/script-runs/{runId}/heartbeat": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Record a script run heartbeat */
        post: operations["script_runs_internal_heartbeat"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/internal/script-runs/{runId}/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Update script run status from subprocess */
        post: operations["script_runs_internal_status"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/internal/raw-llm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Execute a raw LLM call for a script workflow */
        post: operations["script_runs_internal_raw_llm"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/internal/script-runs/{runId}/agent-task": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Create or wait for a script workflow agent task step */
        post: operations["script_runs_internal_agent_task"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/script-connections/{id}/mcp-call": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Invoke a tool on an MCP script connection */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        tool: string;
                        arguments?: {
                            [key: string]: unknown;
                        };
                    };
                };
            };
            responses: {
                /** @description MCP call result */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            ok: true;
                            result: {
                                content: {
                                    type: string;
                                    text?: string;
                                }[];
                                isError?: boolean;
                            };
                        } | {
                            /** @enum {boolean} */
                            ok: false;
                            error: {
                                code?: number;
                                message?: string;
                                data?: unknown;
                            } | string;
                        };
                    };
                };
                /** @description Invalid MCP connection or request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Not allowed to invoke this MCP connection */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Script connection or agent not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/session-logs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Store session logs */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        sessionId: string;
                        iteration: number;
                        lines: string[];
                        taskId?: string;
                        cli?: string;
                    };
                };
            };
            responses: {
                /** @description Logs stored */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                            count: number;
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/tasks/{taskId}/session-logs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get session logs for a task */
        get: {
            parameters: {
                query?: {
                    limit?: number;
                };
                header?: never;
                path: {
                    taskId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Session logs */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            logs: components["schemas"]["SessionLog"][];
                        };
                    };
                };
                /** @description Task not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/session-costs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Query session costs with filters */
        get: {
            parameters: {
                query?: {
                    agentId?: string;
                    taskId?: string;
                    startDate?: string;
                    endDate?: string;
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Session costs */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            costs: components["schemas"]["SessionCost"][];
                        };
                    };
                };
            };
        };
        put?: never;
        /** Store session cost record */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        sessionId: string;
                        agentId: string;
                        totalCostUsd: number;
                        taskId?: string;
                        inputTokens?: number;
                        outputTokens?: number;
                        cacheReadTokens?: number;
                        cacheWriteTokens?: number | null;
                        cacheWrite5mTokens?: number | null;
                        cacheWrite1hTokens?: number | null;
                        reasoningOutputTokens?: number;
                        thinkingTokens?: number;
                        durationMs?: number;
                        numTurns?: number | null;
                        model?: string;
                        models?: {
                            model: string;
                            inputTokens: number;
                            outputTokens: number;
                            cacheReadTokens: number;
                            cacheWriteTokens: number;
                            webSearchRequests?: number | null;
                            harnessCostUsd?: number | null;
                        }[];
                        isError?: boolean;
                        /** @enum {string} */
                        provider?: "claude" | "claude-managed" | "codex" | "pi" | "opencode" | "devin" | "gemini";
                        createdAt?: number;
                    };
                };
            };
            responses: {
                /** @description Cost record stored */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                            cost: components["schemas"]["SessionCost"];
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/session-costs/summary": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Aggregated session cost summary */
        get: {
            parameters: {
                query?: {
                    groupBy?: "day" | "agent" | "both" | "user";
                    startDate?: string;
                    endDate?: string;
                    agentId?: string;
                    userId?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Cost summary */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            totals: {
                                totalCostUsd: number;
                                totalInputTokens: number;
                                totalOutputTokens: number;
                                totalCacheReadTokens: number;
                                totalCacheWriteTokens: number;
                                totalDurationMs: number;
                                totalSessions: number;
                                avgCostPerSession: number;
                                attributedCostUsd: number;
                            };
                            daily: {
                                date: string;
                                costUsd: number;
                                inputTokens: number;
                                outputTokens: number;
                                sessions: number;
                            }[];
                            byAgent: {
                                agentId: string;
                                costUsd: number;
                                inputTokens: number;
                                outputTokens: number;
                                sessions: number;
                                durationMs: number;
                            }[];
                            byUser: {
                                userId: string | null;
                                costUsd: number;
                                inputTokens: number;
                                outputTokens: number;
                                tasks: number;
                                durationMs: number;
                            }[];
                        };
                    };
                };
                /** @description Invalid groupBy */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/session-costs/dashboard": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Cost today and month-to-date for dashboard */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Dashboard cost data */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            costToday: number;
                            costMtd: number;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List recent task sessions (root tasks + chain summary)
         * @description Each item's `root` is a slim task summary by default — the full `task` text is replaced with a bounded `taskPreview` and completion/integration blobs are dropped. Pass `fields=full` to restore the full root `AgentTask`. The full root + descendant chain are on `GET /api/sessions/{rootTaskId}`.
         */
        get: {
            parameters: {
                query?: {
                    limit?: number | null;
                    offset?: number | null;
                    source?: string;
                    q?: string;
                    requestedByUserId?: string;
                    fields?: "full" | "slim";
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Recent sessions ordered by chain-wide last activity */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            sessions: {
                                root: components["schemas"]["AgentTask"] | {
                                    /** Format: uuid */
                                    id: string;
                                    /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                                    key: string;
                                    agentId: string | null;
                                    creatorAgentId?: string;
                                    task: string;
                                    title?: string;
                                    /** @enum {string} */
                                    status: "backlog" | "unassigned" | "offered" | "reviewing" | "pending" | "in_progress" | "paused" | "completed" | "failed" | "cancelled" | "superseded";
                                    /**
                                     * @default mcp
                                     * @enum {string}
                                     */
                                    source: "mcp" | "slack" | "api" | "ui" | "github" | "gitlab" | "agentmail" | "system" | "schedule" | "workflow" | "linear" | "jira";
                                    taskType?: string;
                                    /** @default [] */
                                    tags: string[];
                                    /** @default 50 */
                                    priority: number;
                                    /** @default [] */
                                    dependsOn: string[];
                                    offeredTo?: string;
                                    /** Format: date-time */
                                    acceptedAt?: string;
                                    parentTaskId?: string;
                                    scheduleId?: string;
                                    model?: string;
                                    /** @enum {string} */
                                    modelTier?: "smol" | "regular" | "smart" | "ultra";
                                    /** @enum {string} */
                                    effort?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
                                    /** @enum {string} */
                                    provider?: "claude" | "codex" | "pi" | "devin" | "claude-managed" | "opencode";
                                    requestedByUserId?: string;
                                    progress?: string;
                                    /** Format: date-time */
                                    createdAt: string;
                                    /** Format: date-time */
                                    lastUpdatedAt: string;
                                    /** Format: date-time */
                                    finishedAt?: string;
                                    peakContextPercent?: number;
                                    totalCostUsd?: number;
                                };
                                chainTaskCount: number;
                                lastActivityAt: string;
                                /** @enum {string} */
                                latestStatus: "backlog" | "unassigned" | "offered" | "reviewing" | "pending" | "in_progress" | "paused" | "completed" | "failed" | "cancelled" | "superseded";
                            }[];
                            total: number;
                            limit: number;
                            offset: number;
                        };
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/sessions/{rootTaskId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a session — root task + the entire descendant chain */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    rootTaskId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Root task + chain (ordered by createdAt) */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            root: components["schemas"]["AgentTask"] & {
                                isLeadTask: boolean;
                                supportedSteerModes: ("steer" | "queue")[];
                            };
                            chain: (components["schemas"]["AgentTask"] & {
                                isLeadTask: boolean;
                                supportedSteerModes: ("steer" | "queue")[];
                            })[];
                        };
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Root task not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/skills": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List skills with optional filters
         * @description Returns skills WITHOUT the heavy `content` (full SKILL.md) by default — list views never render it. Pass `fields=full` to include `content` (e.g. for SDK consumers that read it from the list).
         */
        get: {
            parameters: {
                query?: {
                    type?: string;
                    scope?: string;
                    agentId?: string;
                    enabled?: string;
                    search?: string;
                    fields?: "full" | "slim";
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Skill list */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            skills: components["schemas"]["Skill"][];
                            total: number;
                        };
                    };
                };
            };
        };
        put?: never;
        /** Create a new skill */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        content: string;
                        type?: string;
                        scope?: string;
                        ownerAgentId?: string;
                        systemDefault?: boolean;
                    };
                };
            };
            responses: {
                /** @description Skill created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            skill: components["schemas"]["Skill"];
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/skills/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get skill by ID */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Skill details */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Skill"];
                    };
                };
                /** @description Skill not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        /** Update a skill */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            responses: {
                /** @description Skill updated */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            skill: components["schemas"]["Skill"];
                        };
                    };
                };
                /** @description System-managed skills cannot be edited */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Skill not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        post?: never;
        /** Delete a skill */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Skill deleted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                        };
                    };
                };
                /** @description System-managed skills cannot be deleted */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Skill not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/skills/{id}/files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List bundled files for a skill
         * @description Returns a manifest of bundled skill files without file content.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Skill file manifest */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            files: {
                                id: string;
                                skillId: string;
                                path: string;
                                mimeType: string;
                                isBinary: boolean;
                                size: number | null;
                                createdAt: string;
                                lastUpdatedAt: string;
                            }[];
                            total: number;
                        };
                    };
                };
                /** @description Skill not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        /** Bulk upsert bundled files for a skill */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        files: {
                            content: string;
                            mimeType?: string;
                            isBinary?: boolean;
                            size?: number;
                            path: string;
                        }[];
                    };
                };
            };
            responses: {
                /** @description Skill files upserted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            files: components["schemas"]["SkillFile"][];
                            total: number;
                            skill: components["schemas"]["Skill"] | null;
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Skill not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/skills/{id}/files/{path}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a bundled skill file */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    path: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Skill file */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            file: components["schemas"]["SkillFile"];
                        };
                    };
                };
                /** @description Skill or file not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        /** Upsert a bundled skill file */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    path: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        content: string;
                        mimeType?: string;
                        isBinary?: boolean;
                        size?: number;
                    };
                };
            };
            responses: {
                /** @description Skill file upserted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            file: components["schemas"]["SkillFile"];
                            skill: components["schemas"]["Skill"] | null;
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Skill not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        post?: never;
        /** Delete a bundled skill file */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    path: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Skill file deleted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                            skill: components["schemas"]["Skill"] | null;
                        };
                    };
                };
                /** @description Skill or file not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/skills/{id}/install": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Install skill for an agent */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        agentId: string;
                    };
                };
            };
            responses: {
                /** @description Skill installed */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            agentSkill: components["schemas"]["AgentSkill"];
                        };
                    };
                };
                /** @description Skill not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/skills/{id}/install/{agentId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Uninstall skill for an agent */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    agentId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Skill uninstalled */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            success: boolean;
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/skills/install-remote": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Install a remote skill from GitHub */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        sourceRepo: string;
                        sourcePath?: string;
                        scope?: string;
                        isComplex?: boolean;
                    };
                };
            };
            responses: {
                /** @description Remote skill installed */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            skill: components["schemas"]["Skill"];
                        };
                    };
                };
                /** @description Fetch failed */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/skills/sync-remote": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Trigger remote skill sync */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        skillId?: string;
                        force?: boolean;
                    };
                };
            };
            responses: {
                /** @description Sync results */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            updated: number;
                            checked: number;
                            errors: string[];
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/skills/sync-filesystem": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Sync installed skills to agent filesystem */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Filesystem sync results */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            synced: number;
                            removed: number;
                            errors: string[];
                            message: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/agents/{id}/skills": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get all skills installed for an agent */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Agent skills list */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            skills: (components["schemas"]["Skill"] & {
                                isActive: boolean;
                                installedAt: string;
                            })[];
                            total: number;
                            signature: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/agents/{id}/skills/signature": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Compute a stable signature over an agent's installed skills
         * @description Returns a sha256 hash over per-row mutation fields of the agent's active+enabled skill set. Workers poll this to detect skill changes cheaply without fetching the full list.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Skills signature */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            hash: string;
                            count: number;
                            generatedAt: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/scripts/upsert": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create or update a reusable script
         * @description Explicit script upserts run a TypeScript typecheck before writing.
         */
        post: operations["scripts_upsert"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/scripts/run": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Run a reusable or inline script
         * @description Inline source skips typecheck and is auto-saved as a scratch script only on success.
         */
        post: operations["scripts_run"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/scripts/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Search reusable scripts
         * @description Phase 3 search is substring-only over script name and metadata.
         */
        post: operations["scripts_search"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/scripts/{name}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete a reusable script */
        delete: operations["scripts_delete"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/scripts/{name}/types": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get script signature and authoring types */
        get: operations["scripts_types"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/scripts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List saved scripts
         * @description Dashboard read: lean projection without source. Scratch scripts are excluded unless includeScratch=true.
         */
        get: operations["scripts_list"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/scripts/type-defs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get script SDK and stdlib type definitions
         * @description Generated .d.ts blobs for editor integration (e.g. Monaco extraLibs), including per-app types. Cacheable.
         */
        get: operations["scripts_type_defs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/scripts/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get a saved script by id
         * @description Dashboard read: full record including source and parsed signature.
         */
        get: operations["scripts_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/scripts/{id}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List versions of a saved script
         * @description Dashboard read: version history, newest first.
         */
        get: operations["scripts_versions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/scripts/{id}/apis": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List external API endpoints for a script */
        get: operations["scripts_api_list"];
        put?: never;
        /**
         * Expose a script as an external HTTP API endpoint
         * @description Returns the endpoint plus the plaintext bearer token (when authMode is 'bearer').
         */
        post: operations["scripts_api_create"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/scripts/{id}/apis/{endpointId}/secret": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Reveal an endpoint's bearer token */
        get: operations["scripts_api_reveal_secret"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/scripts/{id}/apis/{endpointId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete an external API endpoint */
        delete: operations["scripts_api_delete"];
        options?: never;
        head?: never;
        /** Enable/disable or relabel an external API endpoint */
        patch: operations["scripts_api_update"];
        trace?: never;
    };
    "/api/scripts/{id}/apis/{endpointId}/rotate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Rotate an endpoint's bearer token */
        post: operations["scripts_api_rotate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/mcp-bridge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Generic MCP tool proxy for the scripts SDK bridge */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        tool: string;
                        /** @default {} */
                        args?: {
                            [key: string]: unknown;
                        };
                    };
                };
            };
            responses: {
                /** @description Tool result */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Invalid tool name or args */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Tool not in SDK allowlist */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Tool not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/mcp-servers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List MCP servers with optional filters */
        get: {
            parameters: {
                query?: {
                    scope?: string;
                    transport?: string;
                    ownerAgentId?: string;
                    enabled?: string;
                    search?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description MCP server list */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            servers: components["schemas"]["McpServer"][];
                            total: number;
                        };
                    };
                };
            };
        };
        put?: never;
        /** Create a new MCP server */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        name: string;
                        /** @enum {string} */
                        transport: "stdio" | "http" | "sse";
                        description?: string;
                        scope?: string;
                        ownerAgentId?: string;
                        command?: string;
                        args?: string;
                        url?: string;
                        headers?: string;
                        envConfigKeys?: string;
                        headerConfigKeys?: string;
                    };
                };
            };
            responses: {
                /** @description MCP server created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            server: components["schemas"]["McpServer"];
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/mcp-servers/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get MCP server by ID */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description MCP server details */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["McpServer"];
                    };
                };
                /** @description MCP server not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        /** Update an MCP server */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            responses: {
                /** @description MCP server updated */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            server: components["schemas"]["McpServer"];
                        };
                    };
                };
                /** @description MCP server not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        post?: never;
        /** Delete an MCP server */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description MCP server deleted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            success: boolean;
                            deletedScriptConnectionCount: number;
                        };
                    };
                };
                /** @description MCP server not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/mcp-servers/{id}/install": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Install MCP server for an agent */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        agentId: string;
                    };
                };
            };
            responses: {
                /** @description MCP server installed */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            agentMcpServer: components["schemas"]["AgentMcpServer"];
                        };
                    };
                };
                /** @description MCP server not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/mcp-servers/{id}/install/{agentId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Uninstall MCP server for an agent */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    agentId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description MCP server uninstalled */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            success: boolean;
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/agents/{id}/mcp-servers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get all MCP servers installed for an agent */
        get: {
            parameters: {
                query?: {
                    resolveSecrets?: string;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Agent MCP servers list */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            servers: (components["schemas"]["McpServer"] & {
                                isActive: boolean;
                                installedAt: string;
                                resolvedEnv?: {
                                    [key: string]: string;
                                };
                                resolvedHeaders?: {
                                    [key: string]: string;
                                };
                                authError?: string | null;
                            })[];
                            total: number;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/logs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List agent logs */
        get: {
            parameters: {
                query?: {
                    limit?: number;
                    agentId?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Agent logs */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            logs: components["schemas"]["AgentLog"][];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Dashboard summary stats */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Agent and task statistics */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            agents: {
                                total: number;
                                idle: number;
                                busy: number;
                                offline: number;
                            };
                            tasks: {
                                total: number;
                                unassigned: number | null;
                                offered: number | null;
                                reviewing: number | null;
                                pending: number | null;
                                in_progress: number | null;
                                paused: number | null;
                                completed: number | null;
                                failed: number | null;
                            };
                            steeringEnabled: boolean;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/metrics": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Lightweight swarm-wide counts
         * @description Single JSON object of cheap `COUNT(*)` metrics — tasks (by status), agents (by status), workflows (total + enabled), pages, active sessions, skills. Use this instead of fetching full list payloads just to count. Powers UI footers/sidebars and MCP context.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Swarm metrics counts */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            tasks: {
                                total: number;
                                by_status: {
                                    [key: string]: number;
                                };
                            };
                            agents: {
                                total: number;
                                by_status: {
                                    [key: string]: number;
                                };
                            };
                            workflows: {
                                total: number;
                                enabled: number;
                            };
                            pages: {
                                total: number;
                            };
                            sessions: {
                                active: number;
                            };
                            skills: {
                                total: number;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/services": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List all registered services */
        get: {
            parameters: {
                query?: {
                    status?: string;
                    agentId?: string;
                    name?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Service list */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            services: components["schemas"]["Service"][];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/scheduled-tasks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List scheduled tasks */
        get: {
            parameters: {
                query?: {
                    enabled?: "true" | "false";
                    name?: string;
                    scheduleType?: "recurring" | "one_time";
                    hideCompleted?: "true" | "false";
                    targetType?: "agent-task" | "workflow" | "script";
                    workflowId?: string;
                    scriptName?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Scheduled tasks list */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            scheduledTasks: {
                                /** Format: uuid */
                                id: string;
                                /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                                key: string;
                                name: string;
                                description?: string;
                                cronExpression?: string;
                                intervalMs?: number;
                                taskTemplate?: string;
                                taskType?: string;
                                /** @default [] */
                                tags: string[];
                                /** @default 50 */
                                priority: number;
                                targetAgentId?: string;
                                /** @default true */
                                enabled: boolean;
                                /** Format: date-time */
                                lastRunAt?: string;
                                /** Format: date-time */
                                nextRunAt?: string;
                                createdByAgentId?: string;
                                /** @default UTC */
                                timezone: string;
                                /** @default 0 */
                                consecutiveErrors: number;
                                /** Format: date-time */
                                lastErrorAt?: string;
                                lastErrorMessage?: string;
                                model?: string;
                                /** @enum {string} */
                                modelTier?: "smol" | "regular" | "smart" | "ultra";
                                /**
                                 * @default recurring
                                 * @enum {string}
                                 */
                                scheduleType: "recurring" | "one_time";
                                /**
                                 * @default agent-task
                                 * @enum {string}
                                 */
                                targetType: "agent-task" | "workflow" | "script";
                                /** Format: uuid */
                                workflowId?: string;
                                scriptName?: string;
                                scriptArgs?: {
                                    [key: string]: unknown;
                                };
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: date-time */
                                lastUpdatedAt: string;
                                createdBy?: string;
                                updatedBy?: string;
                                favorite?: boolean;
                            }[];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/concurrent-context": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get concurrent session context for lead awareness */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Concurrent context data */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            processingInboxMessages: {
                                id: string;
                                content: string;
                                source: string;
                                slackChannelId: string | null;
                                slackThreadTs: string | null;
                                createdAt: string;
                            }[];
                            recentTaskDelegations: {
                                id: string;
                                task: string;
                                agentId: string | null;
                                agentName: string | null;
                                creatorAgentId: string | null;
                                status: string;
                                createdAt: string;
                            }[];
                            activeSwarmTasks: {
                                id: string;
                                task: string;
                                agentId: string | null;
                                agentName: string | null;
                                status: string;
                                createdAt: string;
                                progress: string | null;
                            }[];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Identity + setup readiness + live activity for the swarm dashboard
         * @description Single source of truth consumed by the UI home page. Identity comes from SWARM_* envs; the 7 setup milestones each emit `unverified | configured | verified`; activity counts agents alive in the last 5 min and tasks created in the last 24h; agent_fs reports whether AGENT_FS_API_URL is set.
         */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Status payload */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            identity: {
                                name: string;
                                logo_url: string | null;
                                brand_color: string | null;
                                is_cloud: boolean;
                                marketing_url: string | null;
                                hide_cloud_promo: boolean;
                                org_id: string | null;
                            };
                            setup: {
                                /** @enum {string} */
                                id: "harness" | "slack" | "github" | "linear" | "jira" | "workers" | "first_task";
                                label: string;
                                /** @enum {string} */
                                state: "unverified" | "configured" | "verified";
                                hint?: string;
                                action_url?: string;
                                /** @enum {string} */
                                provider?: "claude" | "codex" | "pi" | "devin" | "claude-managed" | "opencode";
                                providers?: {
                                    /** @enum {string} */
                                    provider: "claude" | "codex" | "pi" | "devin" | "claude-managed" | "opencode";
                                    /** @enum {string} */
                                    state: "unverified" | "configured" | "verified";
                                    workers: number;
                                }[];
                            }[];
                            activity: {
                                agents_online: number;
                                leads_online: number;
                                recent_tasks_count: number;
                            };
                            agent_fs: {
                                configured: boolean;
                                base_url: string | null;
                                provider_id: string;
                                capabilities: {
                                    [key: string]: unknown;
                                };
                            };
                            /** @enum {string} */
                            health: "ok" | "degraded" | "broken";
                        };
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/status/test-connection": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Live-test the harness provider's credentials
         * @description Issues a real upstream call (Anthropic /v1/models, OpenAI /v1/models, etc.) for the given provider. Updates an in-memory cache so the next GET /status reports `harness.state = 'verified'` for SWARM_VERIFY_TTL_MS (default 1h).
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        provider: "claude" | "codex" | "pi" | "devin" | "claude-managed" | "opencode";
                    };
                };
            };
            responses: {
                /** @description Live-test result */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            ok: boolean;
                            error?: string;
                            latency_ms: number;
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/tasks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List tasks with filters
         * @description Returns tasks with the full `task` text replaced by a bounded `taskPreview` and completion/integration blobs dropped by default — list views only need the preview. Pass `fields=full` to restore the full `AgentTask`. Fetch a single task in full via `GET /api/tasks/{id}`.
         */
        get: {
            parameters: {
                query?: {
                    status?: string;
                    agentId?: string;
                    scheduleId?: string;
                    /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                    key?: string;
                    /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                    keyPrefix?: string;
                    search?: string;
                    includeHeartbeat?: "true" | "false";
                    createdAfter?: string;
                    createdBefore?: string;
                    source?: string;
                    requestedByUserId?: string;
                    orderBy?: "lastUpdatedAt" | "createdAt";
                    limit?: number | null;
                    offset?: number | null;
                    fields?: "full" | "slim";
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Paginated task list */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            tasks: components["schemas"]["AgentTask"][] | {
                                /** Format: uuid */
                                id: string;
                                /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                                key: string;
                                agentId: string | null;
                                creatorAgentId?: string;
                                task: string;
                                title?: string;
                                /** @enum {string} */
                                status: "backlog" | "unassigned" | "offered" | "reviewing" | "pending" | "in_progress" | "paused" | "completed" | "failed" | "cancelled" | "superseded";
                                /**
                                 * @default mcp
                                 * @enum {string}
                                 */
                                source: "mcp" | "slack" | "api" | "ui" | "github" | "gitlab" | "agentmail" | "system" | "schedule" | "workflow" | "linear" | "jira";
                                taskType?: string;
                                /** @default [] */
                                tags: string[];
                                /** @default 50 */
                                priority: number;
                                /** @default [] */
                                dependsOn: string[];
                                offeredTo?: string;
                                /** Format: date-time */
                                acceptedAt?: string;
                                parentTaskId?: string;
                                scheduleId?: string;
                                model?: string;
                                /** @enum {string} */
                                modelTier?: "smol" | "regular" | "smart" | "ultra";
                                /** @enum {string} */
                                effort?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
                                /** @enum {string} */
                                provider?: "claude" | "codex" | "pi" | "devin" | "claude-managed" | "opencode";
                                requestedByUserId?: string;
                                progress?: string;
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: date-time */
                                lastUpdatedAt: string;
                                /** Format: date-time */
                                finishedAt?: string;
                                peakContextPercent?: number;
                                totalCostUsd?: number;
                            }[];
                            total: number;
                        };
                    };
                };
                /** @description Validation error (e.g. unknown status token) */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        /** Create a new task */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        task: string;
                        agentId?: string;
                        taskType?: string;
                        tags?: string[];
                        priority?: number;
                        dependsOn?: string[];
                        offeredTo?: string;
                        dir?: string;
                        parentTaskId?: string;
                        /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                        key?: string;
                        /** @enum {string} */
                        source?: "mcp" | "slack" | "api" | "ui" | "github" | "gitlab" | "agentmail" | "system" | "schedule" | "workflow" | "linear" | "jira";
                        outputSchema?: {
                            [key: string]: unknown;
                        };
                        contextKey?: string;
                        requestedByUserId?: string;
                        model?: string;
                        /** @enum {string} */
                        modelTier?: "smol" | "regular" | "smart" | "ultra";
                        /** @enum {string} */
                        effort?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
                    };
                };
            };
            responses: {
                /** @description Task created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AgentTask"];
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/tasks/{id}/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /** Update provider session ID and harness metadata for a task */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        claudeSessionId: string;
                        /** @enum {string} */
                        provider: "devin";
                        model?: string;
                        providerMeta: {
                            sessionUrl: string;
                            maxAcuLimit?: number;
                            acuCostUsd?: number;
                        };
                    } | {
                        claudeSessionId: string;
                        /** @enum {string} */
                        provider?: "claude" | "codex" | "pi" | "claude-managed" | "opencode";
                        model?: string;
                        providerMeta?: Record<string, never>;
                        harnessVariant?: string;
                        harnessVariantMeta?: {
                            [key: string]: unknown;
                        };
                    };
                };
            };
            responses: {
                /** @description Session ID updated */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AgentTask"];
                    };
                };
                /** @description Task not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/tasks/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cancel a pending or in-progress task */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Task cancelled */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                            task: components["schemas"]["AgentTask"];
                        };
                    };
                };
                /** @description Cannot cancel terminal task */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Task not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/tasks/{id}/steer": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Deliver a steering message to a running task */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        message: string;
                        /**
                         * @default queue
                         * @enum {string}
                         */
                        mode?: "steer" | "queue";
                        /**
                         * @default degrade
                         * @enum {string}
                         */
                        onUnsupported?: "degrade" | "fail";
                        /** @enum {string} */
                        source?: "ui" | "mcp" | "script" | "slack" | "api";
                        requestedByUserId?: string;
                    };
                };
            };
            responses: {
                /** @description Steering accepted (see `outcome` for what actually happened) */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["SteerResult"];
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Caller cannot steer this task */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Task not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Requested mode unsupported by the target harness and onUnsupported=fail */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/tasks/{id}/steering-messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List steering messages for a task */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Steering messages */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            messages: components["schemas"]["SteeringMessage"][];
                        };
                    };
                };
                /** @description Task not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/steering-messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List pending steering messages for the current worker */
        get: {
            parameters: {
                query?: {
                    taskId?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Pending steering messages */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            messages: components["schemas"]["SteeringMessage"][];
                        };
                    };
                };
                /** @description Missing X-Agent-ID header */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Agent not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/steering-messages/{id}/delivered": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Mark a steering message delivered */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        mode: "steer" | "queue";
                    };
                };
            };
            responses: {
                /** @description Steering message delivery recorded */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            message: components["schemas"]["SteeringMessage"];
                        };
                    };
                };
                /** @description Missing X-Agent-ID header or validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Steering message task is assigned to another agent */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Agent or steering message not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/steering-messages/{id}/handled": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Mark a steering message handled
         * @description Optionally accepts a JSON body `{ note?: string }` — a short acceptance note describing how the steering was incorporated, persisted as `handledNote`.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Steering message acknowledgement recorded */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            message: components["schemas"]["SteeringMessage"];
                        };
                    };
                };
                /** @description Missing X-Agent-ID header or validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Steering message task is assigned to another agent */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Agent or steering message not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/steering-messages/{id}/undeliverable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Promote an undeliverable steering message */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        reason: string;
                    };
                };
            };
            responses: {
                /** @description Steering message promoted to a follow-up task */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            message: components["schemas"]["SteeringMessage"];
                            promotedTaskId?: string;
                        };
                    };
                };
                /** @description Missing X-Agent-ID header or validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Steering message task is assigned to another agent */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Agent or steering message not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/tasks/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get task details with logs and attachments
         * @description Returns the full `AgentTask` row decorated with `logs` (capped by `logsLimit`) and `attachments` (pointer-based artifacts stored on the task, ordered by `created_at`).
         */
        get: {
            parameters: {
                query?: {
                    logsLimit?: number;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Task with logs and attachments */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AgentTask"] & {
                            isLeadTask: boolean;
                            supportedSteerModes: ("steer" | "queue")[];
                            logs: components["schemas"]["AgentLog"][];
                            attachments: components["schemas"]["TaskAttachment"][];
                        };
                    };
                };
                /** @description Task not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/tasks/{id}/progress": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Update task progress text */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        progress: string;
                    };
                };
            };
            responses: {
                /** @description Progress updated */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                        };
                    };
                };
                /** @description Task not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/tasks/{id}/finish": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Mark task as completed or failed (runner endpoint) */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        status: "completed" | "failed";
                        output?: string;
                        failureReason?: string;
                        force?: boolean;
                    };
                };
            };
            responses: {
                /** @description Task finished */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                            alreadyFinished: boolean;
                            task: components["schemas"]["AgentTask"];
                            message?: string;
                            /** @enum {boolean} */
                            wasNoOp?: true;
                            /** @enum {boolean} */
                            wasForcedOverwrite?: true;
                        };
                    };
                };
                /** @description Invalid status */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Not assigned to this agent */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Task not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Differing terminal result text was discarded */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: false;
                            message: string;
                            task: components["schemas"]["AgentTask"];
                            /** @enum {boolean} */
                            alreadyFinished: true;
                            error: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/paused-tasks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get paused tasks for this agent */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Paused task list */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            tasks: components["schemas"]["AgentTask"][];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/tasks/{id}/pause": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Pause an in-progress task */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Task paused */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                            task: components["schemas"]["AgentTask"];
                        };
                    };
                };
                /** @description Task not in_progress */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Task belongs to another agent */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Task not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/tasks/{id}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resume a paused task */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Task resumed */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                            task: components["schemas"]["AgentTask"];
                        };
                    };
                };
                /** @description Task not paused */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Task belongs to another agent */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Task not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/tasks/{id}/supersede": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Supersede an in-progress task (terminate + spawn resume follow-up)
         * @description Marks the original task `superseded` (terminal) and creates a fresh `taskType="resume"` follow-up so a worker can pick up the work in a new provider session. Workflow-step tasks (those with `workflowRunStepId`) are carved out: the original is marked `failed` with reason `superseded_workflow_task` and no follow-up is created — the workflow engine's retry/failure policy applies.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        reason: "graceful_shutdown" | "context_limits" | "manual_supersede" | "crash_recovery";
                    };
                };
            };
            responses: {
                /** @description Task superseded (or workflow-failed) */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                            /** @enum {string} */
                            kind: "alreadyFinished" | "workflow-failed" | "resumed";
                            task: components["schemas"]["AgentTask"] | null;
                            resumeTaskId: string | null;
                            /** @enum {string} */
                            resumeTaskStatus?: "backlog" | "unassigned" | "offered" | "reviewing" | "pending" | "in_progress" | "paused" | "completed" | "failed" | "cancelled" | "superseded";
                        };
                    };
                };
                /** @description Task not in_progress */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Task belongs to another agent */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Task not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/tasks/{id}/vcs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update VCS (PR/MR) info for a task */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        vcsProvider: "github" | "gitlab";
                        vcsRepo: string;
                        vcsNumber: number;
                        /** Format: uri */
                        vcsUrl: string;
                    };
                };
            };
            responses: {
                /** @description VCS info updated */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["AgentTask"];
                    };
                };
                /** @description Task not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/tasks/{id}/title": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Set or clear a task's display title (session rename)
         * @description Sets a human-facing display title override on a task. The sessions UI only reads this from root tasks (session list items), but titles on child tasks are harmless. Pass `title: null` (or an empty string) to clear the override and fall back to the task prompt.
         */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        title: string | null;
                    };
                };
            };
            responses: {
                /** @description Title updated */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            task: components["schemas"]["AgentTask"];
                        };
                    };
                };
                /** @description Task not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/task-templates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List task templates ('To start' bucket) */
        get: {
            parameters: {
                query?: {
                    category?: string;
                    kind?: "task" | "workflow" | "schedule";
                    query?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Task template list */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            templates: components["schemas"]["TaskTemplate"][];
                        };
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/trackers/jira/authorize": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Redirect to Atlassian OAuth consent screen */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Redirect to Atlassian OAuth */
                302: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Failed to generate authorization URL */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Jira integration not configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/trackers/jira/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Handle Jira OAuth callback (resolves cloudId via accessible-resources) */
        get: {
            parameters: {
                query: {
                    code: string;
                    state: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OAuth complete */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Invalid state or code */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Token exchange or accessible-resources fetch failed */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/trackers/jira/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Jira connection status, cloudId/siteUrl, token expiry, expected webhook URL, scope/token-config flags */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Connection status */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            provider: "jira";
                            connected: boolean;
                            cloudId: string | null;
                            siteUrl: string | null;
                            tokenExpiresAt: string | null;
                            scope: string | null;
                            hasManageWebhookScope: boolean;
                            webhookTokenConfigured: boolean;
                            webhookUrl: string;
                            redirectUri: string;
                            webhookIds: {
                                id: number;
                                expiresAt: string;
                                jql: string;
                            }[];
                            manualWebhookInstructions?: string;
                        };
                    };
                };
                /** @description Jira integration not configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/trackers/jira/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Force a Jira OAuth token refresh and return the updated status payload. Useful when an agent observes an expired token via tracker-status / db-query and wants to recover without restarting the server or re-running 3LO. */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Token refreshed; returns same shape as /status */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            provider: "jira";
                            connected: boolean;
                            cloudId: string | null;
                            siteUrl: string | null;
                            tokenExpiresAt: string | null;
                            scope: string | null;
                            hasManageWebhookScope: boolean;
                            webhookTokenConfigured: boolean;
                            webhookUrl: string;
                            redirectUri: string;
                            webhookIds: {
                                id: number;
                                expiresAt: string;
                                jql: string;
                            }[];
                            manualWebhookInstructions?: string;
                        };
                    };
                };
                /** @description Jira not connected (no refresh token stored) */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Refresh failed (e.g. revoked grant, network error) */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Jira integration not configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/trackers/jira/webhook/{token}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Receive Jira webhook events (URL-token authenticated). Phase 2 stub — Phase 3 fills in dispatch. */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    token: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Event accepted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            status: "accepted";
                        } | {
                            /** @enum {string} */
                            status: "duplicate";
                        } | {
                            /** @enum {string} */
                            status: "ignored";
                            /** @enum {string} */
                            reason: "invalid-json";
                        };
                    };
                };
                /** @description Invalid URL token */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Jira webhook handler not configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/trackers/jira/webhook-register": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Register a Jira dynamic webhook (admin only) */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        jqlFilter: string;
                    };
                };
            };
            responses: {
                /** @description Webhook registered */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            webhookId: number;
                            expiresAt: string;
                            jql: string;
                        };
                    };
                };
                /** @description Invalid jqlFilter */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Jira not connected or JIRA_WEBHOOK_TOKEN missing */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/trackers/jira/webhook/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete a Jira dynamic webhook (admin only) */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: number;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Webhook deleted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            deleted: true;
                            webhookId: number;
                        };
                    };
                };
                /** @description Invalid webhook id */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Jira not connected */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/trackers/jira/disconnect": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Fully disconnect Jira: delete all webhooks, drop tokens, clear metadata */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Disconnected */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            disconnected: true;
                            webhooksDeleted: number;
                            webhooksTotal: number;
                            webhookFailures: {
                                id: number;
                                error: string;
                            }[];
                            revokeNote: string;
                        };
                    };
                };
                /** @description Jira not configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/trackers/linear/authorize": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Redirect to Linear OAuth consent screen */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Redirect to Linear OAuth */
                302: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Failed to generate authorization URL */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Linear integration not configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/trackers/linear/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Handle Linear OAuth callback */
        get: {
            parameters: {
                query: {
                    code: string;
                    state: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description OAuth complete */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Invalid state or code */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Token exchange failed */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/trackers/linear/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Linear connection status, token expiry, workspace info, expected webhook URL */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Connection status */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            provider: "linear";
                            connected: boolean;
                            tokenExpiry: string | null;
                            scope: string | null;
                            webhookUrl: string;
                            redirectUri: string;
                        };
                    };
                };
                /** @description Linear integration not configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/trackers/linear/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Force a Linear OAuth token refresh and return the updated status payload. Useful when an agent observes an expired token and wants to recover without restarting the server or re-running OAuth. */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Token refreshed; returns same shape as /status */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            provider: "linear";
                            connected: boolean;
                            tokenExpiry: string | null;
                            scope: string | null;
                            webhookUrl: string;
                            redirectUri: string;
                        };
                    };
                };
                /** @description Linear not connected (no refresh token stored) */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Refresh failed */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Linear integration not configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/trackers/linear/webhook": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Handle Linear webhook events (signature-verified) */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Event accepted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            status: "duplicate" | "accepted";
                        };
                    };
                };
                /** @description Invalid signature */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Linear integration not configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/trackers/linear/disconnect": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Fully disconnect Linear: revoke OAuth grant + drop tokens */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Disconnected */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            disconnected: true;
                            revoked: boolean;
                        };
                    };
                };
                /** @description Linear not configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List all users with identities, token summaries and recent events */
        get: {
            parameters: {
                query?: {
                    recentEvents?: number | null;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description List of users */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            users: ((components["schemas"]["User"] & {
                                identities: {
                                    kind: string;
                                    externalId: string;
                                }[];
                                tokens: {
                                    id: string;
                                    userId: string;
                                    label: string | null;
                                    tokenPreview: string;
                                    createdAt: string;
                                    lastUsedAt: string | null;
                                    revokedAt: string | null;
                                }[];
                                recentEvents: {
                                    id: string;
                                    userId: string;
                                    eventType: string;
                                    actor: string;
                                    before?: unknown;
                                    after?: unknown;
                                    createdAt: string;
                                }[];
                            }) | null)[];
                        };
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        /** Create a new user (optionally with initial identity links) */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        name: string;
                        email?: string;
                        role?: string;
                        notes?: string;
                        emailAliases?: string[];
                        preferredChannel?: string;
                        timezone?: string;
                        metadata?: {
                            [key: string]: unknown;
                        };
                        dailyBudgetUsd?: number | null;
                        /** @enum {string} */
                        status?: "invited" | "active" | "suspended";
                        identities?: {
                            kind: string;
                            externalId: string;
                        }[];
                    };
                };
            };
            responses: {
                /** @description User created */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            user: (components["schemas"]["User"] & {
                                identities: {
                                    kind: string;
                                    externalId: string;
                                }[];
                                tokens: {
                                    id: string;
                                    userId: string;
                                    label: string | null;
                                    tokenPreview: string;
                                    createdAt: string;
                                    lastUsedAt: string | null;
                                    revokedAt: string | null;
                                }[];
                                recentEvents: {
                                    id: string;
                                    userId: string;
                                    eventType: string;
                                    actor: string;
                                    before?: unknown;
                                    after?: unknown;
                                    createdAt: string;
                                }[];
                            }) | null;
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/unmapped": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List unmapped external identities (kv-backed triage queue) */
        get: {
            parameters: {
                query?: {
                    kind?: string;
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description List of unmapped identities sorted by count DESC, lastSeenAt DESC */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            unmapped: {
                                kind: string;
                                externalId: string;
                                lastSeenAt: string | null;
                                count: number;
                                sampleEventType: string | null;
                                sampleContext?: unknown;
                            }[];
                        };
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/unmapped/{kind}/{externalId}/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resolve an unmapped identity — link to an existing user or create a new one */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    kind: string;
                    externalId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        userId: string;
                    } | {
                        name: string;
                        /** Format: email */
                        email?: string;
                        notes?: string;
                    };
                };
            };
            responses: {
                /** @description Identity linked + kv entries cleared */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            user: (components["schemas"]["User"] & {
                                identities: {
                                    kind: string;
                                    externalId: string;
                                }[];
                                tokens: {
                                    id: string;
                                    userId: string;
                                    label: string | null;
                                    tokenPreview: string;
                                    createdAt: string;
                                    lastUsedAt: string | null;
                                    revokedAt: string | null;
                                }[];
                                recentEvents: {
                                    id: string;
                                    userId: string;
                                    eventType: string;
                                    actor: string;
                                    before?: unknown;
                                    after?: unknown;
                                    createdAt: string;
                                }[];
                            }) | null;
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Target user not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a user by ID with identities, token summaries and recent events */
        get: {
            parameters: {
                query?: {
                    recentEvents?: number | null;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description User row */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            user: components["schemas"]["User"] & {
                                identities: {
                                    kind: string;
                                    externalId: string;
                                }[];
                                tokens: {
                                    id: string;
                                    userId: string;
                                    label: string | null;
                                    tokenPreview: string;
                                    createdAt: string;
                                    lastUsedAt: string | null;
                                    revokedAt: string | null;
                                }[];
                                recentEvents: {
                                    id: string;
                                    userId: string;
                                    eventType: string;
                                    actor: string;
                                    before?: unknown;
                                    after?: unknown;
                                    createdAt: string;
                                }[];
                            };
                        };
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description User not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update an existing user (profile / budget / status / email-aliases / identities) */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        name?: string;
                        email?: string;
                        role?: string;
                        notes?: string;
                        emailAliases?: string[];
                        preferredChannel?: string;
                        timezone?: string;
                        metadata?: {
                            [key: string]: unknown;
                        } | null;
                        dailyBudgetUsd?: number | null;
                        /** @enum {string} */
                        status?: "invited" | "active" | "suspended";
                        identities?: {
                            kind: string;
                            externalId: string;
                        }[];
                    };
                };
            };
            responses: {
                /** @description User updated */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            user: (components["schemas"]["User"] & {
                                identities: {
                                    kind: string;
                                    externalId: string;
                                }[];
                                tokens: {
                                    id: string;
                                    userId: string;
                                    label: string | null;
                                    tokenPreview: string;
                                    createdAt: string;
                                    lastUsedAt: string | null;
                                    revokedAt: string | null;
                                }[];
                                recentEvents: {
                                    id: string;
                                    userId: string;
                                    eventType: string;
                                    actor: string;
                                    before?: unknown;
                                    after?: unknown;
                                    createdAt: string;
                                }[];
                            }) | null;
                        };
                    };
                };
                /** @description Validation error or empty body */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description User not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/users/{id}/mcp-tokens": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Mint a one-time plaintext MCP token for a user
         * @description Returns the plaintext token exactly once. Subsequent reads only expose token summaries.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        label?: string | null;
                    };
                };
            };
            responses: {
                /** @description Minted token plaintext, token summary and composed user */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            plaintext: string;
                            token?: {
                                id: string;
                                userId: string;
                                label: string | null;
                                tokenPreview: string;
                                createdAt: string;
                                lastUsedAt: string | null;
                                revokedAt: string | null;
                            };
                            user: (components["schemas"]["User"] & {
                                identities: {
                                    kind: string;
                                    externalId: string;
                                }[];
                                tokens: {
                                    id: string;
                                    userId: string;
                                    label: string | null;
                                    tokenPreview: string;
                                    createdAt: string;
                                    lastUsedAt: string | null;
                                    revokedAt: string | null;
                                }[];
                                recentEvents: {
                                    id: string;
                                    userId: string;
                                    eventType: string;
                                    actor: string;
                                    before?: unknown;
                                    after?: unknown;
                                    createdAt: string;
                                }[];
                            }) | null;
                        };
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description User not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{id}/mcp-tokens/{tokenId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Revoke a user's MCP token */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    tokenId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Composed user after token revocation */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            user: (components["schemas"]["User"] & {
                                identities: {
                                    kind: string;
                                    externalId: string;
                                }[];
                                tokens: {
                                    id: string;
                                    userId: string;
                                    label: string | null;
                                    tokenPreview: string;
                                    createdAt: string;
                                    lastUsedAt: string | null;
                                    revokedAt: string | null;
                                }[];
                                recentEvents: {
                                    id: string;
                                    userId: string;
                                    eventType: string;
                                    actor: string;
                                    before?: unknown;
                                    after?: unknown;
                                    createdAt: string;
                                }[];
                            }) | null;
                        };
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description User or token not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{id}/merge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Merge another user into this one — moves identities + email aliases, deletes source */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        sourceUserId: string;
                    };
                };
            };
            responses: {
                /** @description Merged user */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            user: (components["schemas"]["User"] & {
                                identities: {
                                    kind: string;
                                    externalId: string;
                                }[];
                                tokens: {
                                    id: string;
                                    userId: string;
                                    label: string | null;
                                    tokenPreview: string;
                                    createdAt: string;
                                    lastUsedAt: string | null;
                                    revokedAt: string | null;
                                }[];
                                recentEvents: {
                                    id: string;
                                    userId: string;
                                    eventType: string;
                                    actor: string;
                                    before?: unknown;
                                    after?: unknown;
                                    createdAt: string;
                                }[];
                            }) | null;
                        };
                    };
                };
                /** @description Validation error (e.g. target == source) */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Target or source user not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Paginated identity-event timeline for a user (DESC by createdAt) */
        get: {
            parameters: {
                query?: {
                    limit?: number;
                    before?: string;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Array of identity events */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            events: {
                                id: string;
                                userId: string;
                                eventType: string;
                                actor: string;
                                before?: unknown;
                                after?: unknown;
                                createdAt: string;
                            }[];
                        };
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description User not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{id}/identities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Link a new (kind, externalId) identity to this user */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        kind: string;
                        externalId: string;
                    };
                };
            };
            responses: {
                /** @description Updated identity list */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            identities: {
                                kind: string;
                                externalId: string;
                            }[];
                        };
                    };
                };
                /** @description Validation error or PK collision */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description User not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{id}/identities/{kind}/{externalId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove a (kind, externalId) identity link from this user */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    kind: string;
                    externalId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Updated identity list */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            identities: {
                                kind: string;
                                externalId: string;
                            }[];
                        };
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description User not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/github/webhook": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Handle GitHub webhook events */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Event processed */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            message: "pong";
                        } | {
                            created: boolean;
                            taskId?: string;
                        };
                    };
                };
                /** @description Invalid signature */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description GitHub integration not configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/gitlab/webhook": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Handle GitLab webhook events */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Event processed */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            created: boolean;
                            taskId?: string;
                        };
                    };
                };
                /** @description Invalid token */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description GitLab integration not configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/agentmail/webhook": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Handle AgentMail webhook events */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Event received */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            received: true;
                        };
                    };
                };
                /** @description Invalid signature */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description AgentMail integration not configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/kapso/webhook": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Handle native Kapso/WhatsApp webhook events */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Event received */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            received: true;
                            /** @enum {string} */
                            routing: "skip" | "duplicate" | "workflow" | "task" | "no_mapping" | "error";
                        };
                    };
                };
                /** @description Invalid signature */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Kapso integration not configured */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/workflow-runs/{runId}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Fire a run-scoped event signal
         * @description Emits an event onto the workflow event bus with `_runId` injected. Used by wait nodes in `event` mode with `scope: 'run'`. The body's `name` is the bus event name; `payload` is forwarded as-is plus `_runId`.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    runId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        name: string;
                        payload?: {
                            [key: string]: unknown;
                        };
                    };
                };
            };
            responses: {
                /** @description Event emitted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            ok: true;
                            name: string;
                            runId: string;
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Workflow run not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/workflow-events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Fire a global workflow event signal
         * @description Emits an event onto the workflow event bus. Wait-states with `scope: 'global'` may match. Run-scoped waits will NOT match this broadcast unless the payload carries a matching `workflowRunId`.
         */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        name: string;
                        payload?: {
                            [key: string]: unknown;
                        };
                    };
                };
            };
            responses: {
                /** @description Event emitted */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            ok: true;
                            name: string;
                        };
                    };
                };
                /** @description Validation error */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/workflows": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List all workflows
         * @description Returns workflows WITHOUT the heavy `definition` (the full DAG) by default — the list view only needs a `nodeCount`, which is included. Pass `fields=full` to restore `definition` + trigger config. Fetch the full workflow via `GET /api/workflows/{id}`.
         */
        get: {
            parameters: {
                query?: {
                    enabled?: "true" | "false";
                    consecutiveErrorsMin?: number | null;
                    lastRunStatus?: "running" | "waiting" | "completed" | "failed" | "skipped" | "cancelled";
                    /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                    key?: string;
                    /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                    keyPrefix?: string;
                    fields?: "full" | "slim";
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Workflow list */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: uuid */
                            id: string;
                            /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                            key: string;
                            name: string;
                            description?: string;
                            enabled: boolean;
                            dir?: string;
                            vcsRepo?: string;
                            createdByAgentId?: string;
                            createdAt: string;
                            lastUpdatedAt: string;
                            createdBy?: string;
                            updatedBy?: string;
                            favorite: boolean;
                            nodeCount: number;
                        }[] | (components["schemas"]["Workflow"] & Record<string, never>)[];
                    };
                };
            };
        };
        put?: never;
        /** Create a new workflow */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        name: string;
                        /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                        key?: string;
                        description?: string;
                        definition: components["schemas"]["WorkflowDefinition"];
                        triggers?: ({
                            /** @enum {string} */
                            type: "webhook";
                            hmacSecret?: string;
                            /**
                             * @description Legacy HMAC header for webhook verification. Prefer verification.header for new workflows.
                             * @default X-Hub-Signature-256
                             */
                            hmacHeader?: string;
                            /** @description Optional webhook verification format. Omit to keep legacy HMAC-SHA256 behavior with fallback header scanning. */
                            verification?: {
                                /** @enum {string} */
                                format: "hmac-sha256";
                                /**
                                 * @description Header containing HMAC-SHA256 over the raw request body. Accepts sha256=<hex> or bare hex.
                                 * @default X-Hub-Signature-256
                                 */
                                header?: string;
                            } | {
                                /** @enum {string} */
                                format: "timestamped-hmac-sha256";
                                /** @description Header containing comma-separated timestamp/signature pairs such as t=<timestamp>,v1=<hex>. */
                                header: string;
                                /**
                                 * @description Timestamp field key in the signature header
                                 * @default t
                                 */
                                timestampKey?: string;
                                /**
                                 * @description Signature field key in the signature header; multiple entries are allowed
                                 * @default v1
                                 */
                                signatureKey?: string;
                                /**
                                 * @description Maximum allowed clock skew, in seconds, for replay protection
                                 * @default 300
                                 */
                                toleranceSeconds?: number;
                            } | {
                                /** @enum {string} */
                                format: "token-equality";
                                /** @description Header containing the shared token to compare */
                                header: string;
                            };
                        } | {
                            /** @enum {string} */
                            type: "schedule";
                            /** Format: uuid */
                            scheduleId: string;
                        })[];
                        cooldown?: {
                            hours?: number;
                            minutes?: number;
                            seconds?: number;
                        };
                        input?: {
                            [key: string]: string;
                        };
                        triggerSchema?: {
                            [key: string]: unknown;
                        };
                        dir?: string;
                        vcsRepo?: string;
                    };
                };
            };
            responses: {
                /** @description Workflow created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Workflow"];
                    };
                };
                /** @description Invalid definition */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/workflows/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a workflow by ID */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Workflow details with auto-generated edges */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Workflow"] & {
                            edges: components["schemas"]["WorkflowEdge"][];
                        };
                    };
                };
                /** @description Workflow not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        /** Update a workflow */
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        name?: string;
                        /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                        key?: string;
                        description?: string;
                        definition?: components["schemas"]["WorkflowDefinition"];
                        triggers?: ({
                            /** @enum {string} */
                            type: "webhook";
                            hmacSecret?: string;
                            /**
                             * @description Legacy HMAC header for webhook verification. Prefer verification.header for new workflows.
                             * @default X-Hub-Signature-256
                             */
                            hmacHeader?: string;
                            /** @description Optional webhook verification format. Omit to keep legacy HMAC-SHA256 behavior with fallback header scanning. */
                            verification?: {
                                /** @enum {string} */
                                format: "hmac-sha256";
                                /**
                                 * @description Header containing HMAC-SHA256 over the raw request body. Accepts sha256=<hex> or bare hex.
                                 * @default X-Hub-Signature-256
                                 */
                                header?: string;
                            } | {
                                /** @enum {string} */
                                format: "timestamped-hmac-sha256";
                                /** @description Header containing comma-separated timestamp/signature pairs such as t=<timestamp>,v1=<hex>. */
                                header: string;
                                /**
                                 * @description Timestamp field key in the signature header
                                 * @default t
                                 */
                                timestampKey?: string;
                                /**
                                 * @description Signature field key in the signature header; multiple entries are allowed
                                 * @default v1
                                 */
                                signatureKey?: string;
                                /**
                                 * @description Maximum allowed clock skew, in seconds, for replay protection
                                 * @default 300
                                 */
                                toleranceSeconds?: number;
                            } | {
                                /** @enum {string} */
                                format: "token-equality";
                                /** @description Header containing the shared token to compare */
                                header: string;
                            };
                        } | {
                            /** @enum {string} */
                            type: "schedule";
                            /** Format: uuid */
                            scheduleId: string;
                        })[];
                        cooldown?: {
                            hours?: number;
                            minutes?: number;
                            seconds?: number;
                        } | null;
                        input?: {
                            [key: string]: string;
                        } | null;
                        triggerSchema?: {
                            [key: string]: unknown;
                        } | null;
                        dir?: string | null;
                        vcsRepo?: string | null;
                        enabled?: boolean;
                    };
                };
            };
            responses: {
                /** @description Workflow updated (version snapshot created) */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Workflow"];
                    };
                };
                /** @description Invalid definition */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Workflow not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        post?: never;
        /** Delete a workflow */
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Workflow deleted */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Workflow not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        options?: never;
        head?: never;
        /** Patch a workflow definition (create/update/delete nodes) */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": components["schemas"]["WorkflowPatch"] & {
                        /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
                        key?: string;
                    };
                };
            };
            responses: {
                /** @description Workflow patched (version snapshot created) */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Workflow"];
                    };
                };
                /** @description Invalid patch or resulting definition */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Workflow not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/workflows/{id}/nodes/{nodeId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Patch a single node in a workflow definition */
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    nodeId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @description Executor type: 'agent-task', 'script', 'swarm-script', 'raw-llm', 'validate', 'property-match' */
                        type?: string;
                        /** @description Human-readable label for UI display */
                        label?: string;
                        /** @description Executor-specific config. For agent-task: { template, outputSchema?, agentId?, tags?, priority?, dir?, vcsRepo?, model? }. For swarm-script: { scriptName, scope?, pinHash?, args?, fsMode?, timeoutMs? (1000-300000) }. Values support {{interpolation}} from the node's inputs context. NOTE: config.outputSchema on agent-task nodes validates the AGENT's raw JSON output, while node-level outputSchema validates the EXECUTOR's return value ({taskId, taskOutput}). */
                        config?: {
                            [key: string]: unknown;
                        };
                        /** @description Next node(s): string for simple chaining, string[] for fan-out to parallel nodes, or record for port-based routing ({pass: 'a', fail: 'b'}) */
                        next?: string | string[] | {
                            [key: string]: string;
                        };
                        validation?: components["schemas"]["StepValidationConfig"];
                        retry?: components["schemas"]["RetryPolicy"];
                        /** @description REQUIRED for cross-node data access. Maps local names to context paths. Without this, upstream step outputs are NOT available for interpolation — only 'trigger' and 'input' are. Example: { "cityData": "generate-city" } → use {{cityData.taskOutput.field}} in config templates. For trigger data: { "pr": "trigger.pullRequest" }. */
                        inputs?: {
                            [key: string]: string;
                        };
                        /** @description JSON Schema to validate resolved inputs before execution */
                        inputSchema?: {
                            [key: string]: unknown;
                        };
                        /** @description JSON Schema to validate the executor's output (e.g. {taskId, taskOutput} for agent-task). Different from config.outputSchema which validates the agent's raw output. */
                        outputSchema?: {
                            [key: string]: unknown;
                        };
                    };
                };
            };
            responses: {
                /** @description Node patched (version snapshot created) */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["Workflow"];
                    };
                };
                /** @description Invalid patch or resulting definition */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Workflow or node not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/workflows/{id}/trigger": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Trigger a workflow execution */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Workflow run started (or skipped if cooldown active) */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            runId: string;
                            skipped: boolean;
                        };
                    };
                };
                /** @description Workflow is disabled */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Unauthorized */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Workflow not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/workflows/{id}/trigger/validate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Validate a payload against the workflow's triggerSchema (no run) */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Payload matches the workflow's triggerSchema (or workflow has none) */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            valid: true;
                            schema?: null;
                        };
                    };
                };
                /** @description Payload failed validation; body matches the TriggerSchemaError contract */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Workflow not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/workflows/{id}/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List runs for a workflow */
        get: {
            parameters: {
                query?: {
                    status?: "running" | "waiting" | "completed" | "failed" | "skipped" | "cancelled";
                    limit?: number;
                    offset?: number | null;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Workflow run list */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["WorkflowRun"][] | {
                            runs: components["schemas"]["WorkflowRun"][];
                            page: {
                                limit: number;
                                offset: number;
                                total: number;
                                hasMore: boolean;
                                nextOffset?: number;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/workflow-runs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a workflow run with steps (includes retry columns) */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Workflow run details with steps including retry info */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            run: components["schemas"]["WorkflowRun"];
                            steps: components["schemas"]["WorkflowRunStep"][];
                        };
                    };
                };
                /** @description Run not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/workflow-runs/{id}/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Retry a failed workflow run */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Retry started */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                        };
                    };
                };
                /** @description Cannot retry */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/workflow-runs/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cancel a running or waiting workflow run */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        reason?: string;
                    };
                };
            };
            responses: {
                /** @description Run cancelled */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            success: true;
                        };
                    };
                };
                /** @description Cannot cancel */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/executor-types": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List all executor types with their config and output schemas */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description List of executor types with schemas */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            executorTypes: {
                                type: string;
                                /** @enum {string} */
                                mode: "instant" | "async";
                                configSchema: {
                                    [key: string]: unknown;
                                };
                                outputSchema: {
                                    [key: string]: unknown;
                                };
                            }[];
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/executor-types/{type}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a specific executor type with its schemas */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    type: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Executor type details */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            type: string;
                            /** @enum {string} */
                            mode: "instant" | "async";
                            configSchema: {
                                [key: string]: unknown;
                            };
                            outputSchema: {
                                [key: string]: unknown;
                            };
                        };
                    };
                };
                /** @description Executor type not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/webhooks/{workflowId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Trigger workflow via webhook */
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    workflowId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Webhook processed */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            runId: string;
                        };
                    };
                };
                /** @description Invalid signature */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
                /** @description Workflow not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/workflows/{id}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List version history for a workflow */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Version list (newest first) */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            versions: components["schemas"]["WorkflowVersion"][];
                        };
                    };
                };
                /** @description Workflow not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/workflows/{id}/versions/{version}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get a specific version snapshot of a workflow */
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    version: number;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Version snapshot */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["WorkflowVersion"];
                    };
                };
                /** @description Version not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": components["schemas"]["ErrorResponse"];
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/x/script/{endpointId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Invoke an externally-exposed swarm script
         * @description Runs the script bound to this endpoint and returns a JSON envelope `{ ok, result, error, durationMs }` (HTTP 200) once execution is reached. Auth/routing failures use 401 (bad/missing bearer) and 404 (unknown or disabled endpoint). Optional `X-Swarm-Timeout-Ms` header (default 60000, clamped 1000–300000) sets the wall-clock timeout.
         */
        post: operations["x_script_run"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        ActiveSession: {
            /** Format: uuid */
            id: string;
            agentId: string;
            taskId: string | null;
            triggerType: string;
            inboxMessageId: string | null;
            taskDescription: string | null;
            runnerSessionId: string | null;
            providerSessionId: string | null;
            /** Format: date-time */
            startedAt: string;
            /** Format: date-time */
            lastHeartbeatAt: string;
        };
        /** @description Standard error envelope */
        ErrorResponse: {
            error: string;
        } & {
            [key: string]: unknown;
        };
        AgentTask: {
            /** Format: uuid */
            id: string;
            /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
            key: string;
            agentId: string | null;
            creatorAgentId?: string;
            task: string;
            title?: string;
            /** @enum {string} */
            status: "backlog" | "unassigned" | "offered" | "reviewing" | "pending" | "in_progress" | "paused" | "completed" | "failed" | "cancelled" | "superseded";
            /**
             * @default mcp
             * @enum {string}
             */
            source: "mcp" | "slack" | "api" | "ui" | "github" | "gitlab" | "agentmail" | "system" | "schedule" | "workflow" | "linear" | "jira";
            taskType?: string;
            /** @default [] */
            tags: string[];
            /** @default 50 */
            priority: number;
            /** @default [] */
            dependsOn: string[];
            offeredTo?: string;
            /** Format: date-time */
            offeredAt?: string;
            /** Format: date-time */
            acceptedAt?: string;
            rejectionReason?: string;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            lastUpdatedAt: string;
            /** Format: date-time */
            finishedAt?: string;
            /** Format: date-time */
            notifiedAt?: string;
            failureReason?: string;
            output?: string;
            progress?: string;
            slackChannelId?: string;
            slackThreadTs?: string;
            slackTriggerMessageTs?: string;
            slackUserId?: string;
            /** @default false */
            slackReplySent: boolean;
            slackProgressMessageTs?: string;
            slackTreeRootMessageTs?: string;
            /** @enum {string} */
            vcsProvider?: "github" | "gitlab";
            vcsRepo?: string;
            vcsEventType?: string;
            vcsNumber?: number;
            vcsCommentId?: number;
            vcsAuthor?: string;
            vcsUrl?: string;
            vcsInstallationId?: number;
            vcsNodeId?: string;
            agentmailInboxId?: string;
            agentmailMessageId?: string;
            agentmailThreadId?: string;
            mentionMessageId?: string;
            mentionChannelId?: string;
            dir?: string;
            parentTaskId?: string;
            claudeSessionId?: string;
            model?: string;
            /** @enum {string} */
            modelTier?: "smol" | "regular" | "smart" | "ultra";
            /** @enum {string} */
            effort?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
            scheduleId?: string;
            /** Format: uuid */
            workflowRunId?: string | null;
            /** Format: uuid */
            workflowRunStepId?: string | null;
            contextKey?: string;
            outputSchema?: {
                [key: string]: unknown;
            };
            followUpConfig?: components["schemas"]["FollowUpConfig"];
            /** @default false */
            wasPaused: boolean;
            compactionCount?: number;
            peakContextPercent?: number;
            peakContextTokens?: number;
            contextWindowSize?: number;
            credentialKeySuffix?: string;
            credentialKeyType?: string;
            requestedByUserId?: string;
            swarmVersion?: string;
            /** @enum {string} */
            provider?: "claude" | "codex" | "pi" | "devin" | "claude-managed" | "opencode";
            providerMeta?: {
                [key: string]: unknown;
            };
            harnessVariant?: string;
            harnessVariantMeta?: {
                [key: string]: unknown;
            };
            totalCostUsd?: number;
            routingAffinity?: components["schemas"]["RoutingAffinity"];
        };
        FollowUpConfig: {
            disabled?: boolean;
            onCompleted?: string;
            onFailed?: string;
        };
        RoutingAffinity: {
            sourceAgentId?: string;
            role?: string;
            /** @enum {string} */
            harnessProvider?: "claude" | "codex" | "pi" | "devin" | "claude-managed" | "opencode";
            /** @default [] */
            capabilities: string[];
        };
        AgentCredStatus: {
            ready: boolean;
            /** @default [] */
            missing: string[];
            /**
             * @default null
             * @enum {string|null}
             */
            satisfiedBy: "env" | "file" | "side-effect-pending" | "sdk-delegated" | null;
            /** @default null */
            hint: string | null;
            liveTest?: components["schemas"]["AgentCredStatusLiveTest"];
            latestModel?: components["schemas"]["AgentLatestModel"];
            reportedAt: number;
            /**
             * @default boot
             * @enum {string}
             */
            reportKind: "boot" | "post_task";
            bedrock?: components["schemas"]["AgentBedrockStatus"];
        };
        /** @default null */
        AgentCredStatusLiveTest: {
            ok: boolean;
            /** @default null */
            error: string | null;
            latency_ms: number;
            testedAt: number;
        } | null;
        /** @default null */
        AgentLatestModel: {
            model: string;
            /** @enum {string} */
            source: "task" | "agent_config" | "adapter_default" | "custom";
            /** @default null */
            taskId: string | null;
            /**
             * @default null
             * @enum {string|null}
             */
            harnessProvider: "claude" | "codex" | "pi" | "devin" | "claude-managed" | "opencode" | null;
            reportedAt: number;
            /** @enum {string} */
            reasoningEffort?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
        } | null;
        /** @default null */
        AgentBedrockStatus: {
            region: string;
            probedAt: number;
            ready: boolean;
            /** @default [] */
            models: {
                id: string;
                name: string;
            }[];
            error?: string;
        } | null;
        Agent: {
            id: string;
            name: string;
            /** @default false */
            isLead: boolean;
            /** @enum {string} */
            status: "idle" | "busy" | "offline" | "waiting_for_credentials";
            description?: string;
            role?: string;
            /** @default [] */
            capabilities: string[];
            claudeMd?: string;
            soulMd?: string;
            identityMd?: string;
            setupScript?: string;
            toolsMd?: string;
            heartbeatMd?: string;
            maxTasks?: number;
            emptyPollCount?: number;
            /** Format: date-time */
            lastActivityAt?: string;
            /** @enum {string} */
            provider?: "claude" | "codex" | "pi" | "devin" | "claude-managed" | "opencode";
            /** @enum {string|null} */
            harnessProvider?: "claude" | "codex" | "pi" | "devin" | "claude-managed" | "opencode" | null;
            credentialMissing?: string[] | null;
            credStatus?: components["schemas"]["AgentCredStatus"] | null;
            avatar?: {
                /** @enum {string} */
                type: "lucide";
                icon: string;
                color?: string;
            };
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            lastUpdatedAt: string;
        };
        AssetSummary: {
            /** @enum {string} */
            entityType: "task" | "workflow" | "schedule" | "page" | "file";
            id: string;
            /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
            key: string;
            label: string;
            updatedAt: string;
            providerRef?: components["schemas"]["AssetProviderRef"];
        };
        AssetProviderRef: {
            providerId: string;
            orgId?: string;
            driveId?: string;
            providerKey: string;
        };
        AssetKeyMapping: {
            id: string;
            providerId: string;
            providerOrgId?: string;
            providerDriveId?: string;
            providerKey: string;
            /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
            key: string;
            /** @enum {string} */
            sourceEntityType?: "task-attachment" | "external";
            sourceEntityId?: string;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            updatedAt: string;
            createdBy?: string;
            updatedBy?: string;
        };
        Budget: {
            /** @enum {string} */
            scope: "global" | "agent" | "user";
            scopeId: string;
            dailyBudgetUsd: number;
            createdAt: number;
            lastUpdatedAt: number;
        };
        BudgetRefusalNotification: {
            taskId: string;
            date: string;
            agentId: string;
            /** @enum {string} */
            cause: "agent" | "global" | "user";
            agentSpendUsd?: number | null;
            agentBudgetUsd?: number | null;
            globalSpendUsd?: number | null;
            globalBudgetUsd?: number | null;
            userSpendUsd?: number | null;
            userBudgetUsd?: number | null;
            followUpTaskId?: string | null;
            createdAt: number;
        };
        SwarmConfig: {
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            scope: "global" | "agent" | "repo";
            scopeId: string | null;
            key: string;
            value: string;
            isSecret: boolean;
            envPath: string | null;
            description: string | null;
            createdAt: string;
            lastUpdatedAt: string;
            encrypted: boolean;
        };
        ContextSnapshot: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            taskId: string;
            agentId: string;
            sessionId: string;
            contextUsedTokens?: number;
            contextTotalTokens?: number;
            contextPercent?: number;
            /** @enum {string} */
            eventType: "progress" | "compaction" | "completion";
            /** @enum {string} */
            compactTrigger?: "auto" | "manual" | "auto-inferred";
            preCompactTokens?: number;
            /** @default 0 */
            cumulativeInputTokens: number;
            /** @default 0 */
            cumulativeOutputTokens: number;
            /** @enum {string} */
            contextFormula?: "input-cache-output" | "input-cache-no-output" | "input-output-no-cache" | "peak-proxy" | "pi-delegated" | "harness-reported" | "unknown";
            /** Format: date-time */
            createdAt: string;
        };
        SwarmEvent: {
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            category: "tool" | "skill" | "session" | "api" | "task" | "workflow" | "system";
            /** @enum {string} */
            event: "tool.start" | "tool.end" | "skill.invoke" | "skill.complete" | "session.start" | "session.end" | "session.resume" | "session.cost" | "api.request" | "api.error" | "task.poll" | "task.assign" | "task.timeout" | "workflow.step.start" | "workflow.step.end" | "workflow.run.start" | "workflow.run.end" | "system.boot" | "system.migration" | "system.error" | "script.global_upsert" | "schedule.deleted";
            /** @enum {string} */
            status: "ok" | "error" | "timeout" | "skipped";
            /** @enum {string} */
            source: "worker" | "api" | "hook" | "scheduler" | "cli";
            agentId?: string;
            taskId?: string;
            sessionId?: string;
            parentEventId?: string;
            numericValue?: number;
            durationMs?: number;
            data?: {
                [key: string]: unknown;
            };
            /** Format: date-time */
            createdAt: string;
        };
        UserFavorite: {
            id: string;
            userId?: string;
            /** @enum {string} */
            itemType: "page" | "workflow" | "schedule";
            itemId: string;
            createdAt: string;
            lastUpdatedAt: string;
            createdBy?: string;
            updatedBy?: string;
        };
        TaskAttachment: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            taskId: string;
            agentId: string | null;
            name: string;
            /** @enum {string} */
            kind: "agent-fs" | "url" | "shared-fs" | "page";
            url?: string;
            path?: string;
            pageId?: string;
            providerId?: string;
            providerKey?: string;
            capabilities?: {
                [key: string]: unknown;
            };
            orgId?: string;
            driveId?: string;
            mimeType?: string;
            sizeBytes?: number;
            sha256?: string;
            intent?: string;
            description?: string;
            /** @default false */
            isPrimary: boolean;
            /** Format: date-time */
            createdAt: string;
            createdBy?: string;
            updatedBy?: string;
        };
        InboxItemState: {
            id: string;
            userId: string;
            /** @enum {string} */
            itemType: "approval" | "credential_missing" | "broken_task" | "to_read" | "to_start_template";
            itemId: string;
            /** @enum {string} */
            status: "open" | "snoozed" | "dismissed" | "done";
            snoozeUntil?: string;
            dismissedAt?: string;
            doneAt?: string;
            createdAt: string;
            lastUpdatedAt: string;
        };
        KvEntry: {
            namespace: string;
            key: string;
            value?: unknown;
            /** @enum {string} */
            valueType: "json" | "string" | "integer";
            expiresAt: number | null;
            createdAt: number;
            updatedAt: number;
        };
        AgentMemory: {
            /** Format: uuid */
            id: string;
            agentId: string | null;
            /** @enum {string} */
            scope: "agent" | "swarm";
            key?: string | null;
            name: string;
            content: string;
            summary: string | null;
            /** @enum {string} */
            source: "manual" | "file_index" | "session_summary" | "task_completion";
            /** Format: uuid */
            sourceTaskId: string | null;
            sourcePath: string | null;
            /** @default 0 */
            chunkIndex: number;
            /** @default 1 */
            totalChunks: number;
            tags: string[];
            createdAt: string;
            updatedAt?: string | null;
            accessedAt: string;
            expiresAt?: string | null;
            /** @default 0 */
            accessCount: number;
            embeddingModel?: string | null;
            contentHash?: string | null;
            /** @default 1 */
            version: number;
        };
        MetricDefinition: {
            /** @enum {number} */
            version: 1;
            widgets: components["schemas"]["MetricWidget"][];
            variables?: components["schemas"]["MetricVariable"][];
            layout?: {
                columns?: number;
            };
            refreshSeconds?: number;
        };
        MetricWidget: {
            id: string;
            title: string;
            description?: string;
            query: {
                sql: string;
                params?: (string | number | boolean | null)[];
                maxRows?: number;
            };
            viz: components["schemas"]["MetricVizConfig"];
            colSpan?: number;
            rowSpan?: number;
        };
        MetricVizConfig: {
            /** @enum {string} */
            type: "stat" | "table" | "bar" | "line" | "multi-bar" | "multi-line";
            x?: string;
            y?: string;
            series?: string[];
            label?: string;
            value?: string;
            columns?: {
                key: string;
                label?: string;
                /** @enum {string} */
                format?: "number" | "integer" | "currency" | "percent" | "duration";
            }[];
            /** @enum {string} */
            format?: "number" | "integer" | "currency" | "percent" | "duration";
        };
        MetricVariable: {
            key: string;
            label?: string;
            /**
             * @default text
             * @enum {string}
             */
            type: "text" | "number" | "select";
            defaultValue?: string | number | boolean | null;
            options?: {
                label: string;
                value: string | number | boolean | null;
            }[];
            optionsQuery?: {
                sql: string;
                valueKey: string;
                labelKey?: string;
            };
        };
        Metric: {
            id: string;
            agentId: string;
            slug: string;
            title: string;
            description?: string;
            definition: components["schemas"]["MetricDefinition"];
            createdAt: string;
            updatedAt: string;
        };
        MetricVersion: {
            id: string;
            metricId: string;
            version: number;
            snapshot: components["schemas"]["MetricSnapshot"];
            changedByAgentId?: string;
            createdAt: string;
        };
        MetricSnapshot: {
            title: string;
            description?: string;
            definition: components["schemas"]["MetricDefinition"];
        };
        Page: {
            id: string;
            /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
            key: string;
            agentId: string;
            slug: string;
            title: string;
            description?: string;
            /** @enum {string} */
            contentType: "text/html" | "application/json";
            /** @enum {string} */
            authMode: "public" | "authed" | "password";
            passwordHash?: string;
            body: string;
            needsCredentials?: string[];
            /** @default 0 */
            viewCount: number;
            createdAt: string;
            updatedAt: string;
            favorite?: boolean;
        };
        PageVersion: {
            id: string;
            pageId: string;
            version: number;
            snapshot: components["schemas"]["PageSnapshot"];
            changedByAgentId?: string;
            createdAt: string;
        };
        PageSnapshot: {
            title: string;
            description?: string;
            /** @enum {string} */
            contentType: "text/html" | "application/json";
            /** @enum {string} */
            authMode: "public" | "authed" | "password";
            passwordHash?: string;
            body: string;
            needsCredentials?: string[];
        };
        PromptTemplate: {
            id: string;
            eventType: string;
            /** @enum {string} */
            scope: "global" | "agent" | "repo";
            scopeId: string | null;
            /** @enum {string} */
            state: "enabled" | "default_prompt_fallback" | "skip_event";
            body: string;
            isDefault: boolean;
            version: number;
            createdBy: string | null;
            createdAt: string;
            updatedAt: string;
        };
        PromptTemplateHistory: {
            id: string;
            templateId: string;
            version: number;
            body: string;
            state: string;
            changedBy: string | null;
            changedAt: string;
            changeReason: string | null;
        };
        BudgetRefusedTrigger: {
            /** @enum {string} */
            type: "budget_refused";
            /** @enum {string} */
            cause: "agent" | "global" | "user";
            agentSpend?: number;
            agentBudget?: number;
            globalSpend?: number;
            globalBudget?: number;
            userSpend?: number;
            userBudget?: number;
            resetAt: string;
        };
        PricingRow: {
            /** @enum {string} */
            provider: "claude" | "claude-managed" | "codex" | "pi" | "opencode" | "devin" | "gemini";
            model: string;
            /** @enum {string} */
            tokenClass: "input" | "cached_input" | "output" | "cache_write" | "cache_write_1h" | "web_search" | "runtime_hour" | "acu";
            effectiveFrom: number;
            pricePerMillionUsd: number;
            createdAt: number;
            lastUpdatedAt: number;
        };
        SwarmRepo: {
            /** Format: uuid */
            id: string;
            url: string;
            name: string;
            clonePath: string;
            /** @default main */
            defaultBranch: string;
            /** @default true */
            autoClone: boolean;
            hooks?: components["schemas"]["RepoHooks"];
            guidelines?: components["schemas"]["RepoGuidelines"];
            createdAt: string;
            lastUpdatedAt: string;
        };
        /**
         * @default {
         *       "enabled": false
         *     }
         */
        RepoHooks: {
            /** @default false */
            enabled: boolean;
        };
        RepoGuidelines: {
            prChecks: string[];
            mergeChecks: string[];
            /** @default false */
            allowMerge: boolean;
            review: string[];
        } | null;
        ScriptRun: {
            /** Format: uuid */
            id: string;
            agentId: string;
            scriptName?: string;
            source: string;
            args?: unknown;
            /** @enum {string} */
            kind: "workflow" | "inline";
            /** @enum {string} */
            status: "running" | "paused" | "completed" | "failed" | "cancelled" | "aborted_limit";
            pid?: number;
            startedAt: string;
            finishedAt?: string;
            output?: unknown;
            error?: string;
            lastHeartbeatAt?: string;
            idempotencyKey?: string;
            requestedByUserId?: string;
        };
        ScriptRunJournalEntry: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            runId: string;
            stepKey: string;
            stepType: string;
            config: {
                [key: string]: unknown;
            };
            /** @enum {string} */
            status: "completed" | "failed";
            result?: unknown;
            error?: string;
            startedAt: string;
            completedAt?: string;
            durationMs?: number;
        };
        SessionLog: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            taskId?: string;
            sessionId: string;
            iteration: number;
            /** @default claude */
            cli: string;
            content: string;
            lineNumber: number;
            /** Format: date-time */
            createdAt: string;
        };
        SessionCost: {
            /** Format: uuid */
            id: string;
            sessionId: string;
            /** Format: uuid */
            taskId?: string;
            agentId: string;
            totalCostUsd: number;
            /** @default 0 */
            inputTokens: number;
            /** @default 0 */
            outputTokens: number;
            /** @default 0 */
            cacheReadTokens: number;
            /** @default 0 */
            cacheWriteTokens: number;
            /** @default 0 */
            reasoningOutputTokens: number;
            /** @default 0 */
            thinkingTokens: number;
            durationMs: number;
            numTurns: number | null;
            model: string;
            /** @default false */
            isError: boolean;
            /**
             * @default harness
             * @enum {string}
             */
            costSource: "harness" | "pricing-table" | "unpriced";
            harnessCostUsd?: number | null;
            cacheWrite5mTokens?: number | null;
            cacheWrite1hTokens?: number | null;
            modelBreakdown?: components["schemas"]["SessionCostModelBreakdown"][] | null;
            /** Format: date-time */
            createdAt: string;
        };
        SessionCostModelBreakdown: {
            model: string;
            inputTokens: number;
            outputTokens: number;
            cacheReadTokens: number;
            cacheWriteTokens: number;
            webSearchRequests?: number | null;
            costUsd?: number | null;
            harnessCostUsd?: number | null;
        };
        Skill: {
            id: string;
            name: string;
            description: string;
            content: string;
            /** @enum {string} */
            type: "remote" | "personal";
            /** @enum {string} */
            scope: "global" | "swarm" | "agent";
            ownerAgentId: string | null;
            sourceUrl: string | null;
            sourceRepo: string | null;
            sourcePath: string | null;
            sourceBranch: string;
            sourceHash: string | null;
            isComplex: boolean;
            allowedTools: string | null;
            model: string | null;
            effort: string | null;
            context: string | null;
            agent: string | null;
            disableModelInvocation: boolean;
            userInvocable: boolean;
            version: number;
            isEnabled: boolean;
            systemDefault: boolean;
            createdAt: string;
            lastUpdatedAt: string;
            lastFetchedAt: string | null;
        };
        SkillFile: {
            id: string;
            skillId: string;
            path: string;
            content: string;
            mimeType: string;
            isBinary: boolean;
            size: number | null;
            createdAt: string;
            lastUpdatedAt: string;
        };
        AgentSkill: {
            id: string;
            agentId: string;
            skillId: string;
            isActive: boolean;
            installedAt: string;
        };
        ScriptVersionRecord: {
            id: string;
            scriptId: string;
            version: number;
            source: string;
            description: string;
            intent: string;
            signatureJson: string;
            contentHash: string;
            changedByAgentId: string | null;
            changedAt: string;
            changeReason: string | null;
        };
        ScriptApiRecord: {
            id: string;
            scriptId: string;
            agentId: string;
            /** @enum {string} */
            authMode: "none" | "bearer";
            enabled: boolean;
            label: string | null;
            callCount: number;
            lastUsedAt: string | null;
            createdAt: string;
        };
        McpServer: {
            id: string;
            name: string;
            description: string | null;
            /** @enum {string} */
            scope: "global" | "swarm" | "agent";
            ownerAgentId: string | null;
            /** @enum {string} */
            transport: "stdio" | "http" | "sse";
            command: string | null;
            args: string | null;
            url: string | null;
            headers: string | null;
            envConfigKeys: string | null;
            headerConfigKeys: string | null;
            extraAuthorizeParams: string | null;
            /**
             * @default static
             * @enum {string}
             */
            authMethod: "static" | "oauth" | "auto";
            isEnabled: boolean;
            version: number;
            createdAt: string;
            lastUpdatedAt: string;
        };
        AgentMcpServer: {
            id: string;
            agentId: string;
            mcpServerId: string;
            isActive: boolean;
            installedAt: string;
        };
        AgentLog: {
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            eventType: "agent_joined" | "agent_status_change" | "agent_left" | "task_created" | "task_status_change" | "task_progress" | "task_steering" | "task_offered" | "task_accepted" | "task_rejected" | "task_claimed" | "task_claim_rejected_affinity" | "task_released" | "channel_message" | "service_registered" | "service_unregistered" | "service_status_change" | "budget.upserted" | "budget.deleted" | "pricing.inserted" | "pricing.deleted" | "pricing.refresh" | "pricing.refresh.failed" | "task_superseded";
            agentId?: string;
            taskId?: string;
            oldValue?: string;
            newValue?: string;
            metadata?: string;
            /** Format: date-time */
            createdAt: string;
        };
        Service: {
            /** Format: uuid */
            id: string;
            agentId: string;
            name: string;
            /** @default 3000 */
            port: number;
            description?: string;
            /** Format: uri */
            url?: string;
            /** @default /health */
            healthCheckPath: string;
            /**
             * @default starting
             * @enum {string}
             */
            status: "starting" | "healthy" | "unhealthy" | "stopped";
            script: string;
            cwd?: string;
            interpreter?: string;
            args?: string[];
            env?: {
                [key: string]: string;
            };
            /** @default {} */
            metadata: {
                [key: string]: unknown;
            };
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            lastUpdatedAt: string;
        };
        SteerResult: {
            /** @enum {string} */
            outcome: "steered" | "queued" | "promoted";
            /** Format: uuid */
            steeringMessageId?: string;
            /** Format: uuid */
            promotedTaskId?: string;
            /** @enum {string} */
            effectiveMode: "steer" | "queue";
            /** @enum {string} */
            degradedFrom?: "steer" | "queue";
        };
        SteeringMessage: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            taskId: string;
            body: string;
            /** @enum {string} */
            mode: "steer" | "queue";
            /** @enum {string} */
            status: "pending" | "delivered" | "handled" | "promoted" | "cancelled";
            /** @enum {string} */
            deliveredMode?: "steer" | "queue";
            /** @enum {string} */
            source: "ui" | "mcp" | "script" | "slack" | "api";
            /** @enum {string} */
            createdByKind: "user" | "agent" | "system";
            createdByUserId?: string;
            createdByAgentId?: string;
            /** Format: uuid */
            promotedTaskId?: string;
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            deliveredAt?: string;
            /** Format: date-time */
            handledAt?: string;
            handledNote?: string;
        };
        TaskTemplate: {
            id: string;
            title: string;
            description: string;
            prompt: string;
            /**
             * @default task
             * @enum {string}
             */
            kind: "task" | "workflow" | "schedule";
            /** @default {} */
            payload: {
                [key: string]: unknown;
            };
            category?: string;
            /** @default [] */
            tags: string[];
            createdAt: string;
        };
        User: {
            id: string;
            name: string;
            email?: string;
            role?: string;
            notes?: string;
            /** @default [] */
            emailAliases: string[];
            /** @default slack */
            preferredChannel: string;
            timezone?: string;
            metadata?: {
                [key: string]: unknown;
            };
            dailyBudgetUsd?: number | null;
            /**
             * @default active
             * @enum {string}
             */
            status: "invited" | "active" | "suspended";
            /** Format: date-time */
            createdAt: string;
            /** Format: date-time */
            lastUpdatedAt: string;
        };
        WorkflowDefinition: {
            nodes: components["schemas"]["WorkflowNode"][];
            /**
             * @description Behavior when a node's task fails or is cancelled. 'fail' (default): mark the entire run as failed. 'continue': treat the failed node as completed with error output and proceed — downstream convergence nodes receive '[FAILED: reason]' and can handle partial results.
             * @default fail
             * @enum {string}
             */
            onNodeFailure: "fail" | "continue";
        };
        WorkflowNode: {
            /** @description Unique node identifier, used in 'next' and 'inputs' mappings */
            id: string;
            /** @description Executor type: 'agent-task', 'script', 'swarm-script', 'raw-llm', 'validate', 'property-match' */
            type: string;
            /** @description Human-readable label for UI display */
            label?: string;
            /** @description Executor-specific config. For agent-task: { template, outputSchema?, agentId?, tags?, priority?, dir?, vcsRepo?, model? }. For swarm-script: { scriptName, scope?, pinHash?, args?, fsMode?, timeoutMs? (1000-300000) }. Values support {{interpolation}} from the node's inputs context. NOTE: config.outputSchema on agent-task nodes validates the AGENT's raw JSON output, while node-level outputSchema validates the EXECUTOR's return value ({taskId, taskOutput}). */
            config: {
                [key: string]: unknown;
            };
            /** @description Next node(s): string for simple chaining, string[] for fan-out to parallel nodes, or record for port-based routing ({pass: 'a', fail: 'b'}) */
            next?: string | string[] | {
                [key: string]: string;
            };
            validation?: components["schemas"]["StepValidationConfig"];
            retry?: components["schemas"]["RetryPolicy"];
            /** @description REQUIRED for cross-node data access. Maps local names to context paths. Without this, upstream step outputs are NOT available for interpolation — only 'trigger' and 'input' are. Example: { "cityData": "generate-city" } → use {{cityData.taskOutput.field}} in config templates. For trigger data: { "pr": "trigger.pullRequest" }. */
            inputs?: {
                [key: string]: string;
            };
            /** @description JSON Schema to validate resolved inputs before execution */
            inputSchema?: {
                [key: string]: unknown;
            };
            /** @description JSON Schema to validate the executor's output (e.g. {taskId, taskOutput} for agent-task). Different from config.outputSchema which validates the agent's raw output. */
            outputSchema?: {
                [key: string]: unknown;
            };
        };
        StepValidationConfig: {
            /** @default validate */
            executor: string;
            config: {
                [key: string]: unknown;
            };
            /** @default false */
            mustPass: boolean;
            retry?: components["schemas"]["RetryPolicy"];
        };
        RetryPolicy: {
            /** @default 3 */
            maxRetries: number;
            /**
             * @default exponential
             * @enum {string}
             */
            strategy: "exponential" | "static" | "linear";
            /** @default 1000 */
            baseDelayMs: number;
            /** @default 60000 */
            maxDelayMs: number;
        };
        Workflow: {
            /** Format: uuid */
            id: string;
            /** @description Non-unique asset directory namespace (for example shared/ or personal/<user-id>/drafts/). Runtime write boundaries normalize and validate the canonical form. */
            key: string;
            name: string;
            description?: string;
            enabled: boolean;
            definition: components["schemas"]["WorkflowDefinition"];
            /** @default [] */
            triggers: ({
                /** @enum {string} */
                type: "webhook";
                hmacSecret?: string;
                /**
                 * @description Legacy HMAC header for webhook verification. Prefer verification.header for new workflows.
                 * @default X-Hub-Signature-256
                 */
                hmacHeader: string;
                /** @description Optional webhook verification format. Omit to keep legacy HMAC-SHA256 behavior with fallback header scanning. */
                verification?: {
                    /** @enum {string} */
                    format: "hmac-sha256";
                    /**
                     * @description Header containing HMAC-SHA256 over the raw request body. Accepts sha256=<hex> or bare hex.
                     * @default X-Hub-Signature-256
                     */
                    header: string;
                } | {
                    /** @enum {string} */
                    format: "timestamped-hmac-sha256";
                    /** @description Header containing comma-separated timestamp/signature pairs such as t=<timestamp>,v1=<hex>. */
                    header: string;
                    /**
                     * @description Timestamp field key in the signature header
                     * @default t
                     */
                    timestampKey: string;
                    /**
                     * @description Signature field key in the signature header; multiple entries are allowed
                     * @default v1
                     */
                    signatureKey: string;
                    /**
                     * @description Maximum allowed clock skew, in seconds, for replay protection
                     * @default 300
                     */
                    toleranceSeconds: number;
                } | {
                    /** @enum {string} */
                    format: "token-equality";
                    /** @description Header containing the shared token to compare */
                    header: string;
                };
            } | {
                /** @enum {string} */
                type: "schedule";
                /** Format: uuid */
                scheduleId: string;
            })[];
            cooldown?: {
                hours?: number;
                minutes?: number;
                seconds?: number;
            };
            input?: {
                [key: string]: string;
            };
            triggerSchema?: {
                [key: string]: unknown;
            };
            dir?: string;
            vcsRepo?: string;
            createdByAgentId?: string;
            createdAt: string;
            lastUpdatedAt: string;
            createdBy?: string;
            updatedBy?: string;
            favorite?: boolean;
        };
        WorkflowEdge: {
            id: string;
            source: string;
            sourcePort: string;
            target: string;
        };
        WorkflowPatch: {
            /** @description Nodes to update (partial merge) */
            update?: {
                /** @description ID of the node to update */
                nodeId: string;
                /** @description Partial node data to merge */
                node: {
                    /** @description Executor type: 'agent-task', 'script', 'swarm-script', 'raw-llm', 'validate', 'property-match' */
                    type?: string;
                    /** @description Human-readable label for UI display */
                    label?: string;
                    /** @description Executor-specific config. For agent-task: { template, outputSchema?, agentId?, tags?, priority?, dir?, vcsRepo?, model? }. For swarm-script: { scriptName, scope?, pinHash?, args?, fsMode?, timeoutMs? (1000-300000) }. Values support {{interpolation}} from the node's inputs context. NOTE: config.outputSchema on agent-task nodes validates the AGENT's raw JSON output, while node-level outputSchema validates the EXECUTOR's return value ({taskId, taskOutput}). */
                    config?: {
                        [key: string]: unknown;
                    };
                    /** @description Next node(s): string for simple chaining, string[] for fan-out to parallel nodes, or record for port-based routing ({pass: 'a', fail: 'b'}) */
                    next?: string | string[] | {
                        [key: string]: string;
                    };
                    validation?: components["schemas"]["StepValidationConfig"];
                    retry?: components["schemas"]["RetryPolicy"];
                    /** @description REQUIRED for cross-node data access. Maps local names to context paths. Without this, upstream step outputs are NOT available for interpolation — only 'trigger' and 'input' are. Example: { "cityData": "generate-city" } → use {{cityData.taskOutput.field}} in config templates. For trigger data: { "pr": "trigger.pullRequest" }. */
                    inputs?: {
                        [key: string]: string;
                    };
                    /** @description JSON Schema to validate resolved inputs before execution */
                    inputSchema?: {
                        [key: string]: unknown;
                    };
                    /** @description JSON Schema to validate the executor's output (e.g. {taskId, taskOutput} for agent-task). Different from config.outputSchema which validates the agent's raw output. */
                    outputSchema?: {
                        [key: string]: unknown;
                    };
                };
            }[];
            /** @description Node IDs to delete */
            delete?: string[];
            /** @description New nodes to add */
            create?: components["schemas"]["WorkflowNode"][];
            /**
             * @description Update the definition-level onNodeFailure behavior
             * @enum {string}
             */
            onNodeFailure?: "fail" | "continue";
            /** @description Optional JSON-Schema describing the expected trigger payload shape. Pass an object to set/replace; pass null to clear; omit to leave unchanged. Validator subset: type, required, properties, enum, const, items. Other JSON-Schema keywords are silently ignored. */
            triggerSchema?: {
                [key: string]: unknown;
            } | null;
        };
        WorkflowRun: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            workflowId: string;
            /** @enum {string} */
            status: "running" | "waiting" | "completed" | "failed" | "skipped" | "cancelled";
            triggerData?: unknown;
            context?: {
                [key: string]: unknown;
            };
            error?: string;
            startedAt: string;
            lastUpdatedAt: string;
            finishedAt?: string;
        };
        WorkflowRunStep: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            runId: string;
            nodeId: string;
            nodeType: string;
            /** @enum {string} */
            status: "pending" | "running" | "waiting" | "completed" | "failed" | "skipped" | "cancelled";
            input?: unknown;
            output?: unknown;
            error?: string;
            startedAt: string;
            finishedAt?: string;
            /** @default 0 */
            retryCount: number;
            /** @default 3 */
            maxRetries: number;
            nextRetryAt?: string;
            idempotencyKey?: string;
            diagnostics?: string;
            nextPort?: string;
        };
        WorkflowVersion: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            workflowId: string;
            version: number;
            snapshot: components["schemas"]["WorkflowSnapshot"];
            changedByAgentId?: string;
            createdAt: string;
        };
        WorkflowSnapshot: {
            name: string;
            description?: string;
            definition: components["schemas"]["WorkflowDefinition"];
            triggers: ({
                /** @enum {string} */
                type: "webhook";
                hmacSecret?: string;
                /**
                 * @description Legacy HMAC header for webhook verification. Prefer verification.header for new workflows.
                 * @default X-Hub-Signature-256
                 */
                hmacHeader: string;
                /** @description Optional webhook verification format. Omit to keep legacy HMAC-SHA256 behavior with fallback header scanning. */
                verification?: {
                    /** @enum {string} */
                    format: "hmac-sha256";
                    /**
                     * @description Header containing HMAC-SHA256 over the raw request body. Accepts sha256=<hex> or bare hex.
                     * @default X-Hub-Signature-256
                     */
                    header: string;
                } | {
                    /** @enum {string} */
                    format: "timestamped-hmac-sha256";
                    /** @description Header containing comma-separated timestamp/signature pairs such as t=<timestamp>,v1=<hex>. */
                    header: string;
                    /**
                     * @description Timestamp field key in the signature header
                     * @default t
                     */
                    timestampKey: string;
                    /**
                     * @description Signature field key in the signature header; multiple entries are allowed
                     * @default v1
                     */
                    signatureKey: string;
                    /**
                     * @description Maximum allowed clock skew, in seconds, for replay protection
                     * @default 300
                     */
                    toleranceSeconds: number;
                } | {
                    /** @enum {string} */
                    format: "token-equality";
                    /** @description Header containing the shared token to compare */
                    header: string;
                };
            } | {
                /** @enum {string} */
                type: "schedule";
                /** Format: uuid */
                scheduleId: string;
            })[];
            cooldown?: {
                hours?: number;
                minutes?: number;
                seconds?: number;
            };
            input?: {
                [key: string]: string;
            };
            triggerSchema?: {
                [key: string]: unknown;
            };
            dir?: string;
            vcsRepo?: string;
            enabled: boolean;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    oauth_static_callback: {
        parameters: {
            query?: {
                code?: string;
                state?: string;
                error?: string;
                error_description?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OAuth authorization completed */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Redirect back to the final destination */
            302: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Missing or invalid OAuth callback parameters */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description OAuth app not configured */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Token exchange failed */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    oauth_redirect_uri: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description { redirectUri: string } */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        redirectUri: string;
                    };
                };
            };
        };
    };
    oauth_generic_callback: {
        parameters: {
            query?: {
                code?: string;
                state?: string;
                error?: string;
                error_description?: string;
            };
            header?: never;
            path: {
                provider: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OAuth authorization completed */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Missing or invalid OAuth callback parameters */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description OAuth app not configured */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Token exchange failed */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    script_connections_list: {
        parameters: {
            query?: {
                kind?: "openapi" | "graphql" | "mcp";
                scope?: "global" | "agent" | "repo";
                scopeId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Script connections */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        connections: {
                            id: string;
                            slug: string;
                            displayName: string | null;
                            /** @enum {string} */
                            kind: "raw" | "openapi" | "mcp" | "graphql";
                            /** @enum {string} */
                            scope: "global" | "agent" | "repo";
                            scopeId: string | null;
                            baseUrl: string | null;
                            /** @enum {string} */
                            baseUrlSource: "user" | "spec";
                            baseUrlMismatch?: {
                                specUrl: string;
                                effectiveUrl: string;
                            };
                            allowedHosts: string[];
                            credentialBindingId: string | null;
                            /** @enum {string} */
                            authType: "none" | "bearer" | "header" | "query" | "oauth";
                            authConfigKey: string | null;
                            authAuthorizationId: string | null;
                            authParamName: string | null;
                            authTemplateOverride: string | null;
                            authHostsOverride: string[] | null;
                            /** @enum {string|null} */
                            openapiSpecSourceKind: "url" | "inline" | "agent_fs" | "vendored" | null;
                            openapiSpecSource: string | null;
                            openapiSpecEtag: string | null;
                            openapiSpecFetchedAt: string | null;
                            mcpServerId: string | null;
                            generatedAt: string | null;
                            generationError: string | null;
                            enabled: boolean;
                            version: number;
                            createdAt: string;
                            updatedAt: string;
                            createdBy: string | null;
                            updatedBy: string | null;
                            operationCount: number;
                            toolCount: number;
                            credentialBinding: {
                                id: string;
                                configKey: string;
                                /** @enum {string} */
                                authKind: "config" | "oauth";
                                oauthAuthorizationId?: string;
                                /** @enum {string} */
                                tokenStatus?: "ok" | "expiring" | "refresh-failed" | "revoked" | "missing";
                            } | null;
                            auth: {
                                /** @enum {string} */
                                type: "none" | "bearer" | "header" | "query" | "oauth";
                                configKey?: string;
                                authorizationId?: string;
                                paramName?: string;
                                /** @enum {string} */
                                status?: "ok" | "expiring" | "refresh-failed" | "revoked" | "missing";
                            };
                        }[];
                    };
                };
            };
            /** @description Validation error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    script_connections_upsert: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    id?: string;
                    slug: string;
                    displayName?: string;
                    /** @enum {string} */
                    scope?: "global" | "agent" | "repo";
                    scopeId?: string | null;
                    allowedHosts?: string[];
                    /** Format: uuid */
                    credentialBindingId?: string | null;
                    auth?: {
                        /** @enum {string} */
                        type: "none";
                    } | {
                        /** @enum {string} */
                        type: "bearer";
                        secret?: string;
                        configKey?: string;
                        template?: string;
                        hosts?: string[];
                    } | {
                        /** @enum {string} */
                        type: "header";
                        headerName: string;
                        secret?: string;
                        configKey?: string;
                        template?: string;
                        hosts?: string[];
                    } | {
                        /** @enum {string} */
                        type: "query";
                        paramName: string;
                        secret?: string;
                        configKey?: string;
                        template?: string;
                        hosts?: string[];
                    } | {
                        /** @enum {string} */
                        type: "oauth";
                        authorizationId: string;
                        configKey?: string;
                        template?: string;
                        hosts?: string[];
                    };
                    configKey?: string;
                    headerTemplate?: string;
                    queryTemplate?: string;
                    /** @enum {string} */
                    authKind?: "config" | "oauth";
                    oauthAuthorizationId?: string;
                    enabled?: boolean;
                    /** @enum {string} */
                    kind: "openapi";
                    /** Format: uri */
                    baseUrl?: string;
                    /** Format: uri */
                    openapiSpecUrl?: string;
                    openapiSpecJson?: string;
                    specSource?: {
                        /** @enum {string} */
                        kind: "vendored";
                        slug: string;
                    };
                } | {
                    /** Format: uuid */
                    id?: string;
                    slug: string;
                    displayName?: string;
                    /** @enum {string} */
                    scope?: "global" | "agent" | "repo";
                    scopeId?: string | null;
                    allowedHosts: string[];
                    /** Format: uuid */
                    credentialBindingId?: string | null;
                    auth?: {
                        /** @enum {string} */
                        type: "none";
                    } | {
                        /** @enum {string} */
                        type: "bearer";
                        secret?: string;
                        configKey?: string;
                        template?: string;
                        hosts?: string[];
                    } | {
                        /** @enum {string} */
                        type: "header";
                        headerName: string;
                        secret?: string;
                        configKey?: string;
                        template?: string;
                        hosts?: string[];
                    } | {
                        /** @enum {string} */
                        type: "query";
                        paramName: string;
                        secret?: string;
                        configKey?: string;
                        template?: string;
                        hosts?: string[];
                    } | {
                        /** @enum {string} */
                        type: "oauth";
                        authorizationId: string;
                        configKey?: string;
                        template?: string;
                        hosts?: string[];
                    };
                    configKey?: string;
                    headerTemplate?: string;
                    queryTemplate?: string;
                    /** @enum {string} */
                    authKind?: "config" | "oauth";
                    oauthAuthorizationId?: string;
                    enabled?: boolean;
                    /** @enum {string} */
                    kind: "graphql";
                    /** Format: uri */
                    baseUrl: string;
                } | {
                    /** Format: uuid */
                    id?: string;
                    slug: string;
                    displayName?: string;
                    /** @enum {string} */
                    scope?: "global" | "agent" | "repo";
                    scopeId?: string | null;
                    allowedHosts?: string[];
                    /** Format: uuid */
                    credentialBindingId?: string | null;
                    auth?: {
                        /** @enum {string} */
                        type: "none";
                    } | {
                        /** @enum {string} */
                        type: "bearer";
                        secret?: string;
                        configKey?: string;
                        template?: string;
                        hosts?: string[];
                    } | {
                        /** @enum {string} */
                        type: "header";
                        headerName: string;
                        secret?: string;
                        configKey?: string;
                        template?: string;
                        hosts?: string[];
                    } | {
                        /** @enum {string} */
                        type: "query";
                        paramName: string;
                        secret?: string;
                        configKey?: string;
                        template?: string;
                        hosts?: string[];
                    } | {
                        /** @enum {string} */
                        type: "oauth";
                        authorizationId: string;
                        configKey?: string;
                        template?: string;
                        hosts?: string[];
                    };
                    configKey?: string;
                    headerTemplate?: string;
                    queryTemplate?: string;
                    /** @enum {string} */
                    authKind?: "config" | "oauth";
                    oauthAuthorizationId?: string;
                    enabled?: boolean;
                    /** @enum {string} */
                    kind: "mcp";
                    /** Format: uuid */
                    mcpServerId: string;
                };
            };
        };
        responses: {
            /** @description Saved script connection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        connection: {
                            id: string;
                            slug: string;
                            displayName: string | null;
                            /** @enum {string} */
                            kind: "raw" | "openapi" | "mcp" | "graphql";
                            /** @enum {string} */
                            scope: "global" | "agent" | "repo";
                            scopeId: string | null;
                            baseUrl: string | null;
                            /** @enum {string} */
                            baseUrlSource: "user" | "spec";
                            baseUrlMismatch?: {
                                specUrl: string;
                                effectiveUrl: string;
                            };
                            allowedHosts: string[];
                            credentialBindingId: string | null;
                            /** @enum {string} */
                            authType: "none" | "bearer" | "header" | "query" | "oauth";
                            authConfigKey: string | null;
                            authAuthorizationId: string | null;
                            authParamName: string | null;
                            authTemplateOverride: string | null;
                            authHostsOverride: string[] | null;
                            /** @enum {string|null} */
                            openapiSpecSourceKind: "url" | "inline" | "agent_fs" | "vendored" | null;
                            openapiSpecSource: string | null;
                            openapiSpecEtag: string | null;
                            openapiSpecFetchedAt: string | null;
                            mcpServerId: string | null;
                            generatedAt: string | null;
                            generationError: string | null;
                            enabled: boolean;
                            version: number;
                            createdAt: string;
                            updatedAt: string;
                            createdBy: string | null;
                            updatedBy: string | null;
                            operationCount: number;
                            toolCount: number;
                            credentialBinding: {
                                id: string;
                                configKey: string;
                                /** @enum {string} */
                                authKind: "config" | "oauth";
                                oauthAuthorizationId?: string;
                                /** @enum {string} */
                                tokenStatus?: "ok" | "expiring" | "refresh-failed" | "revoked" | "missing";
                            } | null;
                            auth: {
                                /** @enum {string} */
                                type: "none" | "bearer" | "header" | "query" | "oauth";
                                configKey?: string;
                                authorizationId?: string;
                                paramName?: string;
                                /** @enum {string} */
                                status?: "ok" | "expiring" | "refresh-failed" | "revoked" | "missing";
                            };
                        };
                    };
                };
            };
            /** @description Validation or generation error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Only the lead agent can manage script connections */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    script_connections_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Script connection detail */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        connection: {
                            id: string;
                            slug: string;
                            displayName: string | null;
                            /** @enum {string} */
                            kind: "raw" | "openapi" | "mcp" | "graphql";
                            /** @enum {string} */
                            scope: "global" | "agent" | "repo";
                            scopeId: string | null;
                            baseUrl: string | null;
                            /** @enum {string} */
                            baseUrlSource: "user" | "spec";
                            baseUrlMismatch?: {
                                specUrl: string;
                                effectiveUrl: string;
                            };
                            allowedHosts: string[];
                            credentialBindingId: string | null;
                            /** @enum {string} */
                            authType: "none" | "bearer" | "header" | "query" | "oauth";
                            authConfigKey: string | null;
                            authAuthorizationId: string | null;
                            authParamName: string | null;
                            authTemplateOverride: string | null;
                            authHostsOverride: string[] | null;
                            /** @enum {string|null} */
                            openapiSpecSourceKind: "url" | "inline" | "agent_fs" | "vendored" | null;
                            openapiSpecSource: string | null;
                            openapiSpecEtag: string | null;
                            openapiSpecFetchedAt: string | null;
                            mcpServerId: string | null;
                            generatedAt: string | null;
                            generationError: string | null;
                            enabled: boolean;
                            version: number;
                            createdAt: string;
                            updatedAt: string;
                            createdBy: string | null;
                            updatedBy: string | null;
                            operationCount: number;
                            toolCount: number;
                            credentialBinding: {
                                id: string;
                                configKey: string;
                                /** @enum {string} */
                                authKind: "config" | "oauth";
                                oauthAuthorizationId?: string;
                                /** @enum {string} */
                                tokenStatus?: "ok" | "expiring" | "refresh-failed" | "revoked" | "missing";
                            } | null;
                            auth: {
                                /** @enum {string} */
                                type: "none" | "bearer" | "header" | "query" | "oauth";
                                configKey?: string;
                                authorizationId?: string;
                                paramName?: string;
                                /** @enum {string} */
                                status?: "ok" | "expiring" | "refresh-failed" | "revoked" | "missing";
                            };
                            operations: {
                                name: string;
                                method: string;
                                path: string;
                                parameters?: {
                                    name: string;
                                    in: string;
                                    required: boolean;
                                    schema?: unknown;
                                }[];
                                hasBody?: boolean;
                                successStatus?: string;
                                requestBodySchema?: unknown;
                                responseSchema?: unknown;
                            }[];
                            tools: {
                                name: string;
                                description?: string;
                                inputSchema?: unknown;
                            }[];
                            graphql: boolean;
                            generatedTypes: string;
                            specSummary?: {
                                title?: string;
                                version?: string;
                                pathCount: number;
                            };
                            specPreview?: {
                                json: string;
                                truncated: boolean;
                            };
                        };
                    };
                };
            };
            /** @description Script connection not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    script_connections_refresh: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Refreshed script connection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        connection: {
                            id: string;
                            slug: string;
                            displayName: string | null;
                            /** @enum {string} */
                            kind: "raw" | "openapi" | "mcp" | "graphql";
                            /** @enum {string} */
                            scope: "global" | "agent" | "repo";
                            scopeId: string | null;
                            baseUrl: string | null;
                            /** @enum {string} */
                            baseUrlSource: "user" | "spec";
                            baseUrlMismatch?: {
                                specUrl: string;
                                effectiveUrl: string;
                            };
                            allowedHosts: string[];
                            credentialBindingId: string | null;
                            /** @enum {string} */
                            authType: "none" | "bearer" | "header" | "query" | "oauth";
                            authConfigKey: string | null;
                            authAuthorizationId: string | null;
                            authParamName: string | null;
                            authTemplateOverride: string | null;
                            authHostsOverride: string[] | null;
                            /** @enum {string|null} */
                            openapiSpecSourceKind: "url" | "inline" | "agent_fs" | "vendored" | null;
                            openapiSpecSource: string | null;
                            openapiSpecEtag: string | null;
                            openapiSpecFetchedAt: string | null;
                            mcpServerId: string | null;
                            generatedAt: string | null;
                            generationError: string | null;
                            enabled: boolean;
                            version: number;
                            createdAt: string;
                            updatedAt: string;
                            createdBy: string | null;
                            updatedBy: string | null;
                            operationCount: number;
                            toolCount: number;
                            credentialBinding: {
                                id: string;
                                configKey: string;
                                /** @enum {string} */
                                authKind: "config" | "oauth";
                                oauthAuthorizationId?: string;
                                /** @enum {string} */
                                tokenStatus?: "ok" | "expiring" | "refresh-failed" | "revoked" | "missing";
                            } | null;
                            auth: {
                                /** @enum {string} */
                                type: "none" | "bearer" | "header" | "query" | "oauth";
                                configKey?: string;
                                authorizationId?: string;
                                paramName?: string;
                                /** @enum {string} */
                                status?: "ok" | "expiring" | "refresh-failed" | "revoked" | "missing";
                            };
                        };
                    };
                };
            };
            /** @description Connection cannot be refreshed */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Only the lead agent can manage script connections */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Script connection not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    script_connections_set_enabled: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    enabled: boolean;
                };
            };
        };
        responses: {
            /** @description Updated script connection */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        connection: {
                            id: string;
                            slug: string;
                            displayName: string | null;
                            /** @enum {string} */
                            kind: "raw" | "openapi" | "mcp" | "graphql";
                            /** @enum {string} */
                            scope: "global" | "agent" | "repo";
                            scopeId: string | null;
                            baseUrl: string | null;
                            /** @enum {string} */
                            baseUrlSource: "user" | "spec";
                            baseUrlMismatch?: {
                                specUrl: string;
                                effectiveUrl: string;
                            };
                            allowedHosts: string[];
                            credentialBindingId: string | null;
                            /** @enum {string} */
                            authType: "none" | "bearer" | "header" | "query" | "oauth";
                            authConfigKey: string | null;
                            authAuthorizationId: string | null;
                            authParamName: string | null;
                            authTemplateOverride: string | null;
                            authHostsOverride: string[] | null;
                            /** @enum {string|null} */
                            openapiSpecSourceKind: "url" | "inline" | "agent_fs" | "vendored" | null;
                            openapiSpecSource: string | null;
                            openapiSpecEtag: string | null;
                            openapiSpecFetchedAt: string | null;
                            mcpServerId: string | null;
                            generatedAt: string | null;
                            generationError: string | null;
                            enabled: boolean;
                            version: number;
                            createdAt: string;
                            updatedAt: string;
                            createdBy: string | null;
                            updatedBy: string | null;
                            operationCount: number;
                            toolCount: number;
                            credentialBinding: {
                                id: string;
                                configKey: string;
                                /** @enum {string} */
                                authKind: "config" | "oauth";
                                oauthAuthorizationId?: string;
                                /** @enum {string} */
                                tokenStatus?: "ok" | "expiring" | "refresh-failed" | "revoked" | "missing";
                            } | null;
                            auth: {
                                /** @enum {string} */
                                type: "none" | "bearer" | "header" | "query" | "oauth";
                                configKey?: string;
                                authorizationId?: string;
                                paramName?: string;
                                /** @enum {string} */
                                status?: "ok" | "expiring" | "refresh-failed" | "revoked" | "missing";
                            };
                        };
                    };
                };
            };
            /** @description Only the lead agent can manage script connections */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Script connection not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    credential_bindings_list: {
        parameters: {
            query?: {
                includeManaged?: "true" | "false";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Credential bindings */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        bindings: {
                            id: string;
                            configKey: string;
                            allowedHosts: string[];
                            headerTemplate?: string;
                            queryTemplate?: string;
                            /** @enum {string} */
                            scope: "global" | "agent" | "repo";
                            scopeId?: string | null;
                            active: boolean;
                            /** @enum {string} */
                            authKind: "config" | "oauth";
                            oauthAuthorizationId?: string;
                            /** @enum {string} */
                            source: "default" | "user" | "migration" | "connection";
                            managedByConnectionId: string | null;
                            createdAt: string;
                            updatedAt: string;
                            createdBy: string | null;
                            updatedBy: string | null;
                            /** @enum {string} */
                            tokenStatus?: "ok" | "expiring" | "refresh-failed" | "revoked" | "missing";
                        }[];
                    };
                };
            };
        };
    };
    credential_bindings_upsert: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** Format: uuid */
                    id?: string;
                    configKey: string;
                    allowedHosts: string[];
                    headerTemplate?: string;
                    queryTemplate?: string;
                    /**
                     * @default global
                     * @enum {string}
                     */
                    scope?: "global" | "agent" | "repo";
                    scopeId?: string | null;
                    /** @default true */
                    active?: boolean;
                    /**
                     * @default config
                     * @enum {string}
                     */
                    authKind?: "config" | "oauth";
                    oauthAuthorizationId?: string;
                };
            };
        };
        responses: {
            /** @description Saved credential binding */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        binding: {
                            id: string;
                            configKey: string;
                            allowedHosts: string[];
                            headerTemplate?: string;
                            queryTemplate?: string;
                            /** @enum {string} */
                            scope: "global" | "agent" | "repo";
                            scopeId?: string | null;
                            active: boolean;
                            /** @enum {string} */
                            authKind: "config" | "oauth";
                            oauthAuthorizationId?: string;
                            /** @enum {string} */
                            source: "default" | "user" | "migration" | "connection";
                            managedByConnectionId: string | null;
                            createdAt: string;
                            updatedAt: string;
                            createdBy: string | null;
                            updatedBy: string | null;
                            /** @enum {string} */
                            tokenStatus?: "ok" | "expiring" | "refresh-failed" | "revoked" | "missing";
                        };
                    };
                };
            };
            /** @description Validation error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Only the lead agent can manage script connections */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    oauth_apps_list: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OAuth apps without client secrets */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        oauthApps: {
                            id: string;
                            provider: string;
                            clientId: string;
                            authorizeUrl: string;
                            tokenUrl: string;
                            redirectUri: string;
                            scopes: string[];
                            extraParams?: {
                                [key: string]: string;
                            };
                            /** @enum {string} */
                            tokenAuthStyle: "body" | "basic";
                            /** @enum {string} */
                            tokenBodyFormat: "form" | "json";
                            source: string;
                            /** @enum {string} */
                            tokenStatus: "ok" | "expiring" | "refresh-failed" | "revoked" | "missing";
                            expiresAt: string | null;
                            lastRefreshedAt: string | null;
                            authorizations: {
                                id: string;
                                label: string;
                                accountEmail: string | null;
                                /** @enum {string} */
                                status: "active" | "refresh-failed" | "expired" | "revoked";
                                expiresAt: string | null;
                                scope: string | null;
                                hasRefreshToken: boolean;
                                lastErrorMessage: string | null;
                                lastRefreshedAt: string | null;
                                createdAt: string;
                                updatedAt: string;
                            }[];
                            createdAt: string;
                            updatedAt: string;
                        }[];
                    };
                };
            };
        };
    };
    oauth_apps_upsert: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    id?: string;
                    presetId?: string;
                    provider?: string;
                    clientId: string;
                    clientSecret?: string;
                    /** Format: uri */
                    authorizeUrl?: string;
                    /** Format: uri */
                    tokenUrl?: string;
                    /** Format: uri */
                    userinfoUrl?: string;
                    /** Format: uri */
                    revocationUrl?: string;
                    scopes?: string[];
                    extraParams?: {
                        [key: string]: string;
                    };
                    /** @enum {string} */
                    tokenAuthStyle?: "body" | "basic";
                    /** @enum {string} */
                    tokenBodyFormat?: "form" | "json";
                };
            };
        };
        responses: {
            /** @description Saved OAuth app without client secret */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        oauthApp?: {
                            id: string;
                            provider: string;
                            clientId: string;
                            authorizeUrl: string;
                            tokenUrl: string;
                            redirectUri: string;
                            scopes: string[];
                            extraParams?: {
                                [key: string]: string;
                            };
                            /** @enum {string} */
                            tokenAuthStyle: "body" | "basic";
                            /** @enum {string} */
                            tokenBodyFormat: "form" | "json";
                            source: string;
                            /** @enum {string} */
                            tokenStatus: "ok" | "expiring" | "refresh-failed" | "revoked" | "missing";
                            expiresAt: string | null;
                            lastRefreshedAt: string | null;
                            authorizations: {
                                id: string;
                                label: string;
                                accountEmail: string | null;
                                /** @enum {string} */
                                status: "active" | "refresh-failed" | "expired" | "revoked";
                                expiresAt: string | null;
                                scope: string | null;
                                hasRefreshToken: boolean;
                                lastErrorMessage: string | null;
                                lastRefreshedAt: string | null;
                                createdAt: string;
                                updatedAt: string;
                            }[];
                            createdAt: string;
                            updatedAt: string;
                        };
                        redirectUri: string;
                        setupHints?: string[];
                    };
                };
            };
            /** @description Validation error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Only the lead agent can manage script connections */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    oauth_presets_list: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Curated OAuth presets */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        presets: {
                            id: string;
                            displayName: string;
                            provider: string;
                            authorizeUrl: string;
                            tokenUrl: string;
                            revocationUrl?: string;
                            userinfoUrl?: string;
                            scopes: string[];
                            scopeSeparator?: string;
                            /** @enum {string} */
                            tokenAuthStyle?: "body" | "basic";
                            /** @enum {string} */
                            tokenBodyFormat?: "form" | "json";
                            requiresRefreshTokenRotation?: boolean;
                            extraParams?: {
                                [key: string]: string;
                            };
                            setupHints: string[];
                        }[];
                    };
                };
            };
        };
    };
    oauth_apps_discover: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** Format: uri */
                    url: string;
                };
            };
        };
        responses: {
            /** @description Discovered OAuth metadata */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        authorizeUrl: string;
                        tokenUrl: string;
                        scopes: string[];
                        sourceUrl: string;
                    };
                };
            };
            /** @description Discovery failed */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Only the lead agent can manage script connections */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    oauth_apps_delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                provider: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OAuth app deleted */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {boolean} */
                        success: true;
                        warnings?: string[];
                    };
                };
            };
            /** @description Only the lead agent can manage script connections */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description OAuth app not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    oauth_apps_authorize_url: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** @default default */
                    label?: string;
                    /** Format: uri */
                    finalRedirect?: string;
                };
            };
        };
        responses: {
            /** @description OAuth authorization URL + state */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        authorizeUrl: string;
                        state: string;
                        label: string;
                        redirectUri: string;
                    };
                };
            };
            /** @description Only the lead agent can manage OAuth authorizations */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description OAuth app not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    oauth_app_authorizations_list: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Authorizations without token material */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        authorizations: {
                            id: string;
                            label: string;
                            accountEmail: string | null;
                            /** @enum {string} */
                            status: "active" | "refresh-failed" | "expired" | "revoked";
                            expiresAt: string | null;
                            scope: string | null;
                            hasRefreshToken: boolean;
                            lastErrorMessage: string | null;
                            lastRefreshedAt: string | null;
                            createdAt: string;
                            updatedAt: string;
                        }[];
                    };
                };
            };
            /** @description OAuth app not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    oauth_authorization_delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Authorization revoked + deleted */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {boolean} */
                        deleted: true;
                        revocationAttempted: boolean;
                    };
                };
            };
            /** @description Only the lead agent can manage OAuth authorizations */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Authorization not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    oauth_authorization_refresh: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Refresh result with token status and new expiry */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {boolean} */
                        ok: true;
                        /** @enum {string} */
                        status: "active" | "refresh-failed" | "expired" | "revoked";
                        expiresAt: string | null;
                    };
                };
            };
            /** @description No refresh token stored */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Only the lead agent can manage OAuth authorizations */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Authorization not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Provider token endpoint rejected the refresh */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    integrations_catalog_list: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Integrations catalog entries */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        entries: {
                            id: string;
                            kind: string;
                            slug: string;
                            name: string;
                            description: string;
                            url: string;
                            icon: string | null;
                            domain: string;
                            categories: string[];
                            feeds: string[];
                            vendoredSlug?: string;
                            presetId?: string;
                        }[];
                        cachedAt: string;
                        partial: boolean;
                    };
                };
            };
            /** @description Catalog upstream unavailable */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    integrations_catalog_surface: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                domain: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Trimmed integration surface details for a domain */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        domain: string;
                        summary: string;
                        surfaces: {
                            type: string;
                            name: string;
                            url: string | null;
                            docs: string | null;
                            spec: string | null;
                            auth: {
                                required: boolean;
                                credentialIds: string[];
                                mechanics: {
                                    in: string;
                                    headerName: string | null;
                                    scheme: string | null;
                                } | null;
                            };
                        }[];
                        credentials: {
                            [key: string]: {
                                type: string;
                                label: string;
                                generateUrl: string | null;
                                setup: string | null;
                            };
                        };
                    };
                };
            };
            /** @description No surface data for this domain */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Surface upstream unavailable */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    oauth_app_disconnect: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                provider: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Disconnect result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {boolean} */
                        disconnected: false;
                        message: string;
                    } | {
                        /** @enum {boolean} */
                        disconnected: true;
                        revocationAttempted: boolean;
                    };
                };
            };
            /** @description Only the lead agent can manage script connections */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description OAuth app not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    oauth_app_refresh_tokens: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                provider: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Refresh result with token status and new expiry */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {boolean} */
                        refreshed: true;
                        /** @enum {string} */
                        tokenStatus: "ok" | "expiring" | "refresh-failed" | "revoked" | "missing";
                        expiresAt: string | null;
                    };
                };
            };
            /** @description No stored tokens or provider does not support refresh */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Only the lead agent can manage script connections */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description OAuth app not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Provider token endpoint rejected the refresh */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    script_runs_list: {
        parameters: {
            query?: {
                status?: "running" | "paused" | "completed" | "failed" | "cancelled" | "aborted_limit";
                agentId?: string;
                scriptName?: string;
                limit?: number;
                offset?: number | null;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Paginated script run list */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        runs: {
                            /** Format: uuid */
                            id: string;
                            agentId: string;
                            scriptName?: string;
                            /** @enum {string} */
                            kind: "workflow" | "inline";
                            /** @enum {string} */
                            status: "running" | "paused" | "completed" | "failed" | "cancelled" | "aborted_limit";
                            pid?: number;
                            startedAt: string;
                            finishedAt?: string;
                            error?: string;
                            lastHeartbeatAt?: string;
                            idempotencyKey?: string;
                            requestedByUserId?: string;
                        }[];
                        total: number;
                    };
                };
            };
        };
    };
    script_runs_create: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    source: string;
                    args?: unknown;
                    /** @default true */
                    background?: boolean;
                    idempotencyKey?: string;
                    scriptName?: string;
                    requestedByUserId?: string;
                };
            };
        };
        responses: {
            /** @description Script run created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** @enum {string} */
                        status: "running" | "paused" | "completed" | "failed" | "cancelled" | "aborted_limit";
                        url: string;
                    };
                };
            };
            /** @description Validation or label-lint failure */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Existing idempotent run returned */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** @enum {string} */
                        status: "running" | "paused" | "completed" | "failed" | "cancelled" | "aborted_limit";
                        url: string;
                    };
                };
            };
            /** @description Script run concurrency cap reached */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    script_runs_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Script run detail */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        run: components["schemas"]["ScriptRun"];
                        journal: components["schemas"]["ScriptRunJournalEntry"][];
                    };
                };
            };
            /** @description Script run not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    script_runs_cancel: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Script run cancelled, or already terminal */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Script run not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    script_runs_internal_step_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: string;
                stepKey: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Journal step found */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        stepKey: string;
                        stepType: string;
                        /** @enum {string} */
                        status: "completed" | "failed";
                        result?: unknown;
                        error?: string;
                    };
                };
            };
            /** @description Journal step not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    script_runs_internal_step_create: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    stepKey: string;
                    stepType: string;
                    config?: unknown;
                    /** @enum {string} */
                    status: "completed" | "failed";
                    result?: unknown;
                    error?: string;
                    durationMs?: number;
                };
            };
        };
        responses: {
            /** @description Journal step written */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {boolean} */
                        ok: true;
                    };
                };
            };
            /** @description Script run not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    script_runs_internal_heartbeat: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Heartbeat recorded */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Script run not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    script_runs_internal_status: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    status: "completed";
                    output?: unknown;
                } | {
                    /** @enum {string} */
                    status: "failed";
                    error?: string;
                } | {
                    /** @enum {string} */
                    status: "paused";
                };
            };
        };
        responses: {
            /** @description Status updated */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Script run not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    script_runs_internal_raw_llm: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    prompt: string;
                    model?: string;
                    schema?: {
                        [key: string]: unknown;
                    };
                    fallbackPort?: string;
                };
            };
        };
        responses: {
            /** @description LLM call completed */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        result?: unknown;
                        model: string;
                    };
                };
            };
            /** @description LLM call failed */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    script_runs_internal_agent_task: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                runId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    stepKey: string;
                    template?: string;
                    task?: string;
                    agentId?: string;
                    tags?: string[];
                    priority?: number;
                    offerMode?: boolean;
                    dir?: string;
                    vcsRepo?: string;
                    model?: string;
                    /** Format: uuid */
                    parentTaskId?: string;
                    requestedByUserId?: string;
                    outputSchema?: {
                        [key: string]: unknown;
                    };
                };
            };
        };
        responses: {
            /** @description Agent task completed */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        taskId: string;
                        taskOutput: string | null;
                    };
                };
            };
            /** @description Agent task created or still running */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        taskId: string;
                        /** @enum {string} */
                        status: "backlog" | "unassigned" | "offered" | "reviewing" | "pending" | "in_progress" | "paused" | "completed" | "failed" | "cancelled" | "superseded";
                    };
                };
            };
            /** @description Script run not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    scripts_upsert: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    name: string;
                    source: string;
                    /** @default  */
                    description?: string;
                    /** @default  */
                    intent?: string;
                    /**
                     * @default agent
                     * @enum {string}
                     */
                    scope?: "global" | "agent";
                    /**
                     * @default none
                     * @enum {string}
                     */
                    fsMode?: "none" | "workspace-rw";
                };
            };
        };
        responses: {
            /** @description Script upserted */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        name: string;
                        version: number;
                        contentDeduped: boolean;
                    };
                };
            };
            /** @description Validation or typecheck failure */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Global write requires lead agent */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    scripts_run: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    name?: string;
                    source?: string;
                    args?: unknown;
                    /** @default  */
                    intent?: string;
                    /** @enum {string} */
                    scope?: "global" | "agent";
                    /**
                     * @default none
                     * @enum {string}
                     */
                    fsMode?: "none" | "workspace-rw";
                    idempotencyKey?: string;
                };
            };
        };
        responses: {
            /** @description Script run completed */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        result?: unknown;
                        autoSaved?: {
                            slug: string;
                            reason: string;
                        };
                        kvSaved?: {
                            namespace: string;
                            key: string;
                        };
                        truncated: {
                            stdout: boolean;
                            stderr: boolean;
                        };
                        durationMs: number;
                        stdout: string;
                        stderr: string;
                        exitCode: number;
                        /** @enum {string} */
                        error?: "timeout" | "oom" | "killed" | "import_violation" | "eval_error" | "executor_error";
                        runtimeError?: {
                            name: string;
                            message: string;
                            stack: string;
                            userFrames: {
                                file: string;
                                line: number;
                                column: number;
                                raw: string;
                            }[];
                            userScriptLine?: number;
                            userScriptColumn?: number;
                        };
                    };
                };
            };
            /** @description Validation error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Script not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description workspace-rw scripts are not supported in v1 */
            501: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    scripts_search: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /** @default  */
                    query?: string;
                    /** @enum {string} */
                    scope?: "global" | "agent";
                    /** @default 10 */
                    limit?: number;
                };
            };
        };
        responses: {
            /** @description Matching scripts */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        results: {
                            name: string;
                            signature: {
                                argsType: string;
                                resultType: string;
                                description: string;
                            };
                            argsJsonSchema: {
                                [key: string]: unknown;
                            } | null;
                            description: string;
                            score: number;
                        }[];
                    };
                };
            };
            /** @description Validation error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    scripts_delete: {
        parameters: {
            query?: {
                scope?: "global" | "agent";
            };
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Delete result */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        deleted: boolean;
                    };
                };
            };
            /** @description Validation error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Global delete requires lead agent */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    scripts_types: {
        parameters: {
            query?: {
                scope?: "global" | "agent";
            };
            header?: never;
            path: {
                name: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Script signature and type blobs */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        signature: {
                            argsType: string;
                            resultType: string;
                            description: string;
                        };
                        argsJsonSchema: {
                            [key: string]: unknown;
                        } | null;
                        sdkTypes: string;
                        stdlibTypes: string;
                    };
                };
            };
            /** @description Script not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    scripts_list: {
        parameters: {
            query?: {
                scope?: "global" | "agent";
                includeScratch?: "true" | "false";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Saved scripts */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        scripts: {
                            id: string;
                            name: string;
                            /** @enum {string} */
                            scope: "global" | "agent";
                            scopeId: string | null;
                            description: string;
                            intent: string;
                            version: number;
                            isScratch: boolean;
                            typeChecked: boolean;
                            /** @enum {string} */
                            fsMode: "none" | "workspace-rw";
                            createdByAgentId: string | null;
                            createdAt: string;
                            updatedAt: string;
                        }[];
                    };
                };
            };
            /** @description Validation error */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    scripts_type_defs: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description SDK and stdlib type definition blobs */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        sdkTypes: string;
                        stdlibTypes: string;
                    };
                };
            };
        };
    };
    scripts_get: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Script detail */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        script: {
                            id: string;
                            name: string;
                            /** @enum {string} */
                            scope: "global" | "agent";
                            scopeId: string | null;
                            source: string;
                            description: string;
                            intent: string;
                            signatureJson: string;
                            contentHash: string;
                            version: number;
                            isScratch: boolean;
                            typeChecked: boolean;
                            /** @enum {string} */
                            fsMode: "none" | "workspace-rw";
                            createdByAgentId: string | null;
                            createdAt: string;
                            updatedAt: string;
                            signature: {
                                argsType: string;
                                resultType: string;
                                description: string;
                            };
                            argsJsonSchema: {
                                [key: string]: unknown;
                            } | null;
                            created_by?: string | null;
                            updated_by?: string | null;
                        };
                    };
                };
            };
            /** @description Script not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    scripts_versions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Script versions */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        versions: (components["schemas"]["ScriptVersionRecord"] & {
                            created_by?: string | null;
                            updated_by?: string | null;
                        })[];
                    };
                };
            };
            /** @description Script not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    scripts_api_list: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Endpoints (without secrets) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        apis: components["schemas"]["ScriptApiRecord"][];
                    };
                };
            };
            /** @description Script not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    scripts_api_create: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /**
                     * @default bearer
                     * @enum {string}
                     */
                    authMode?: "none" | "bearer";
                    label?: string;
                    agentId?: string;
                };
            };
        };
        responses: {
            /** @description Endpoint created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ScriptApiRecord"] & {
                        token: string | null;
                    };
                };
            };
            /** @description Validation error or script has no owning agent */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Script not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    scripts_api_reveal_secret: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                endpointId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Decrypted token (null when authMode is 'none') */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        token: string | null;
                    };
                };
            };
            /** @description Endpoint not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    scripts_api_delete: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                endpointId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        deleted: boolean;
                    };
                };
            };
            /** @description Endpoint not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    scripts_api_update: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                endpointId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    enabled?: boolean;
                    label?: string | null;
                };
            };
        };
        responses: {
            /** @description Updated endpoint */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ScriptApiRecord"] | null;
                };
            };
            /** @description Endpoint not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    scripts_api_rotate: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
                endpointId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Endpoint with new plaintext token */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ScriptApiRecord"] & {
                        token: string | null;
                    };
                };
            };
            /** @description Endpoint uses 'none' auth — nothing to rotate */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Endpoint not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    x_script_run: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                endpointId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Script executed — see `ok` in the envelope */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        ok: boolean;
                        result?: unknown;
                        error: {
                            type: string;
                            message: string;
                            details?: string[];
                        } | null;
                        durationMs: number;
                    };
                };
            };
            /** @description Missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            type: string;
                            message: string;
                            details?: string[];
                        };
                    };
                };
            };
            /** @description Endpoint not found or disabled */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: {
                            type: string;
                            message: string;
                            details?: string[];
                        };
                    };
                };
            };
            /** @description workspace-rw scripts are not supported */
            501: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
}
