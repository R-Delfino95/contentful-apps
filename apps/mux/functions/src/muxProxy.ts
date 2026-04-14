import { FunctionEventHandler } from '@contentful/node-apps-toolkit';
import {
  AppActionRequest,
  FunctionEventContext,
  FunctionTypeEnum,
} from '@contentful/node-apps-toolkit/lib/requests/typings';
import { muxFetch } from './helpers/muxClient';

type Parameters = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  body?: string;
};

export const handler: FunctionEventHandler<FunctionTypeEnum.AppActionCall> = async (
  event: AppActionRequest<'Custom', Parameters>,
  context: FunctionEventContext
) => {
  const { method, path, body } = event.body;
  const { muxAccessTokenId, muxAccessTokenSecret } = context.appInstallationParameters;

  const res = await muxFetch(
    { tokenId: muxAccessTokenId, tokenSecret: muxAccessTokenSecret },
    method,
    path,
    body
  );

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    return {
      ok: false,
      error: errorBody?.error?.messages?.[0] || 'Unknown error',
      status: res.status,
    };
  }

  if (res.status === 204) {
    return { ok: true, data: {} };
  }

  const responseBody = await res.json();
  return { ok: true, data: responseBody };
};
