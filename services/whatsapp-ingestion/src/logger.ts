import pino from 'pino';
import { config } from './config';

const isProd = process.env.NODE_ENV === 'production';

/** Application logger. Pretty in dev, JSON in prod. */
export const logger = pino({
  level: config.logLevel,
  transport: isProd
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } },
});
