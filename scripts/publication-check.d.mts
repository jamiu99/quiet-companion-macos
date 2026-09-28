export const root: string;
export function publicationCheck(options?: { binary?: boolean; website?: boolean; directory?: string }): { publication: { repositoryUrl: string; homepageUrl: string; license: string }; problems: string[] };
