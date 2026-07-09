import 'dotenv/config';
import { resolve } from 'node:path';

const env = process.env;
const int = (v: string | undefined, d: number) => (v ? parseInt(v, 10) : d);

export interface Config {
  apiKey: string;
  port: number;
  dataDir: string;
  retentionDays: number;
  flushMaxRows: number;
  flushMaxMs: number;
  cold: { kind: 'local' | 's3'; idleMs: number; s3: S3Config };
  agent: { apiKey: string | undefined; model: string };
}

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  urlStyle: string;
}

export const config: Config = {
  apiKey: env.MO_API_KEY || 'dev-secret-key',
  port: int(env.MO_PORT, 4318),
  dataDir: resolve(env.MO_DATA_DIR || './data'),
  retentionDays: int(env.MO_RETENTION_DAYS, 7),
  flushMaxRows: int(env.MO_FLUSH_MAX_ROWS, 2000),
  flushMaxMs: int(env.MO_FLUSH_MAX_MS, 2000),
  cold: {
    kind: (env.MO_COLD_KIND as 'local' | 's3') || 'local',
    idleMs: int(env.MO_COLD_IDLE_MS, 3_600_000),
    s3: {
      endpoint: env.MO_S3_ENDPOINT || 'http://minio:9000',
      region: env.MO_S3_REGION || 'us-east-1',
      bucket: env.MO_S3_BUCKET || 'mo-spans',
      accessKey: env.MO_S3_ACCESS_KEY || 'minioadmin',
      secretKey: env.MO_S3_SECRET_KEY || 'minioadmin',
      urlStyle: env.MO_S3_URL_STYLE || 'path',
    },
  },
  agent: {
    apiKey: env.ANTHROPIC_API_KEY || undefined,
    model: env.MO_AGENT_MODEL || 'claude-opus-4-8',
  },
};
