import { ModalData } from '../components/UploadConfiguration/ModalUploadAsset';
import { InstallationParams, ResolutionType } from './types';

interface AssetSettings {
  passthrough: string;
  playback_policies: string[];
  video_quality: string;
  meta?: {
    title?: string;
    creator_id?: string;
    external_id?: string;
  };
  static_renditions?: Array<{ resolution: string }>;
  inputs: Array<{
    url?: string;
    generated_subtitles?: Array<{
      language_code: string;
      name: string;
    }>;
    type?: string;
    text_type?: string;
    closed_captions?: boolean;
    language_code?: string;
    name?: string;
  }>;
}

interface AssetInput {
  url: string;
  generated_subtitles?: Array<{
    language_code: string;
    name: string;
  }>;
  type?: string;
  text_type?: string;
  closed_captions?: boolean;
  language_code?: string;
  name?: string;
}

function buildAssetSettings(options: ModalData, passthroughId: string): AssetSettings {
  const settings: AssetSettings = {
    passthrough: passthroughId,
    playback_policies: options.playbackPolicies,
    video_quality: options.videoQuality,
    inputs: [],
  };

  // Metadata case
  if (options.metadataConfig.enabled) {
    // Standard metadata
    if (options.metadataConfig.standardMetadata) {
      const { title, creatorId, externalId } = options.metadataConfig.standardMetadata;
      if (title || creatorId || externalId) {
        settings.meta = {};
        if (title) settings.meta.title = title;
        if (creatorId) settings.meta.creator_id = creatorId;
        if (externalId) settings.meta.external_id = externalId;
      }
    }
    // Custom metadata
    if (options.metadataConfig.customMetadata) {
      settings.passthrough = options.metadataConfig.customMetadata;
    }
  }

  // Captions case
  if (options.captionsConfig.captionsType !== 'off') {
    if (options.captionsConfig.captionsType === 'auto') {
      settings.inputs.push({
        generated_subtitles: [
          {
            language_code: options.captionsConfig.languageCode,
            name: options.captionsConfig.languageName,
          },
        ],
      });
    } else {
      settings.inputs.push({
        url: options.captionsConfig.url,
        type: 'text',
        text_type: 'subtitles',
        closed_captions: options.captionsConfig.closedCaptions,
        language_code: options.captionsConfig.languageCode,
        name: options.captionsConfig.languageName,
      });
    }
  }

  // MP4 renditions case
  if (options.mp4Config.enabled) {
    settings.static_renditions = [];
    if (options.mp4Config.audioOnly) {
      settings.static_renditions.push({
        resolution: 'audio-only',
      });
    }
    if (options.mp4Config.highestResolution) {
      settings.static_renditions.push({
        resolution: 'highest',
      });
    }
  }

  return settings;
}

export async function addByURL(
  apiClient: any,
  sdk: any,
  remoteURL: string,
  options: ModalData,
  responseCheck: (res: any) => boolean | Promise<boolean>,
  setAssetError: (msg: string) => void,
  pollForAssetDetails: () => Promise<void>
) {
  const passthroughId = (sdk.entry.getSys() as { id: string }).id;
  const settings = buildAssetSettings(options, passthroughId);

  const requestBody = {
    ...settings,
    inputs: [
      {
        url: remoteURL,
      } as AssetInput,
    ],
  };

  if (settings.inputs.length > 0) {
    if (settings.inputs[0].generated_subtitles) {
      requestBody.inputs[0] = {
        ...requestBody.inputs[0],
        ...settings.inputs[0],
      };
    } else {
      requestBody.inputs.push({
        ...settings.inputs[0],
        url: settings.inputs[0].url || '',
      } as AssetInput);
    }
  }

  const result = await apiClient.post('/video/v1/assets', JSON.stringify(requestBody));

  if (!(await responseCheck(result))) {
    return;
  }

  const muxUpload = await result.json();

  if ('error' in muxUpload) {
    setAssetError(muxUpload.error.messages[0]);
    return;
  }

  if (muxUpload.data.status === 'errored') {
    setAssetError(muxUpload.data.errors.messages[0]);
    return;
  }

  await sdk.field.setValue({
    assetId: muxUpload.data.id,
  });
  await pollForAssetDetails();
}

export async function getUploadUrl(
  apiClient: any,
  sdk: any,
  options: ModalData,
  responseCheck: (res: any) => boolean | Promise<boolean>
) {
  const passthroughId = (sdk.entry.getSys() as { id: string }).id;
  const { muxEnableAudioNormalize } = sdk.parameters.installation as InstallationParams;
  const settings = buildAssetSettings(options, passthroughId);

  const requestBody = {
    cors_origin: window.location.origin,
    new_asset_settings: {
      ...settings,
      normalize_audio: muxEnableAudioNormalize || false,
    },
  };

  const res = await apiClient.post('/video/v1/uploads', JSON.stringify(requestBody));

  if (!(await responseCheck(res))) {
    return;
  }

  const { data: muxUpload } = await res.json();

  await sdk.field.setValue({
    uploadId: muxUpload.id,
  });

  return muxUpload.url;
}

export async function deleteStaticRendition(
  apiClient: any,
  assetId: string,
  staticRenditionId: string
) {
  return await apiClient.del(`/video/v1/assets/${assetId}/static-renditions/${staticRenditionId}`);
}

export async function createStaticRendition(apiClient: any, assetId: string, type: ResolutionType) {
  return await apiClient.post(
    `/video/v1/assets/${assetId}/static-renditions`,
    JSON.stringify({ resolution: type })
  );
}

export async function updateAsset(apiClient: any, assetId: string, options: ModalData) {
  const requestBody: any = {
    meta: {
      title: '',
      creator_id: '',
      external_id: '',
    },
    passthrough: '',
  };

  if (options.metadataConfig.enabled) {
    const { title, creatorId, externalId } = options.metadataConfig.standardMetadata ?? {};
    requestBody.meta.title = title ?? '';
    requestBody.meta.creator_id = creatorId ?? '';
    requestBody.meta.external_id = externalId ?? '';
    requestBody.passthrough = options.metadataConfig.customMetadata ?? '';
  }

  return await apiClient.patch(`/video/v1/assets/${assetId}`, JSON.stringify(requestBody));
}
