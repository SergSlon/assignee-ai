export const SUPPORTED_POC_TYPES = [
  'AWS::S3::Bucket',
  'AWS::SSM::Parameter',
  'AWS::IAM::Role',
] as const;

export type SupportedPocType = typeof SUPPORTED_POC_TYPES[number];
