export type DetailRequestGuard = {
	next: () => number;
	isCurrent: (sequence: number) => boolean;
	invalidate: () => void;
};

export const createDetailRequestGuard = (): DetailRequestGuard => {
	let current = 0;

	return {
		next: () => {
			current += 1;
			return current;
		},
		isCurrent: (sequence: number) => sequence === current,
		invalidate: () => {
			current += 1;
		}
	};
};
