/*
 * fn-rtl-gain: find the gain an RTL-SDR dongle should be set to, and survey the FM band.
 *
 * A signal is received best when it fills the converter's range: with too little gain
 * it is lost in the rounding of an eight bit converter, with too much its peaks are cut
 * off. The gain is therefore measured, not guessed: the tuner's gain steps are walked, a
 * few milliseconds of signal at each, and the highest step is taken at which next to
 * none of the samples touch the ends of the converter's range.
 *
 * That is not yet the gain to use. A strong station outside the slice the converter
 * sees can overload the tuner's first stages without one sample being cut off: the
 * tuner then manufactures signals that are not on the air, and holds down the ones
 * that are. A receiver that is not overloaded treats every signal alike when its gain
 * is changed; an overloaded one does not. So the slice is looked at with the gain found
 * and with a gain about 6 dB lower, and as long as the signals in it do not all change
 * by the same amount, the gain is taken down a step and the comparison made again.
 *
 * The tuner's own automatic gain is not used: measured, it leaves a large share of the
 * samples cut off.
 *
 *   fn-rtl-gain -f <Hz> [-f <Hz> ...] [-s <samples per second>] [-p <ppm>] [-d <device>]
 *
 * prints one line for each frequency
 *   GAIN: freq=<Hz> gain=<dB> step=<n> of=<n> level=<mean of 127> cut=<percent> backoff=<dB>
 * (backoff: how far the gain was taken down because the tuner was overloaded) and, when
 * more than one frequency was given, the gain that suits them all:
 *   BAND: gain=<dB> step=<n> of=<n>
 *
 *   fn-rtl-gain -b <low>:<high>:<spacing> [-p <ppm>] [-d <device>]
 *
 * surveys a band of FM broadcast channels, low to high in steps of spacing. The band is
 * taken in slices of 2 MHz, each at its own gain, and every channel is measured:
 *   SLICE: freq=<Hz> gain=<dB> step=<n> of=<n> level=<mean of 127> cut=<percent> backoff=<dB> floor=<dB>
 *   CHANNEL: freq=<Hz> rf=<dB> top=<0|1> [pilot=<dB> low=<dB> offset=<Hz> again=<dB>|->]
 * rf is the power in the channel, referred to the aerial socket (the gain taken off), on
 * a scale of its own; top says that the channel holds more than both its neighbours. A
 * channel that does is demodulated, and the 19 kHz pilot every stereo station sends is
 * measured against the noise above the programme (62 to 73 kHz): pilot is the middle of
 * the readings, low the least of them, offset how far the carrier lies from the
 * channel's centre. again is the pilot once more with the gain about 6 dB lower: a
 * station keeps its pilot, a signal the tuner manufactured loses it.
 *
 *   fn-rtl-gain -b <low>:<high>:<spacing> -r <file> -c <Hz> [-g <dB>] [-a <file>]
 *
 * does the same on one slice recorded with rtl_sdr at 2400000 samples per second and
 * centred on -c, instead of a dongle; -g is the gain it was recorded with, -a a second
 * recording of the slice with the gain about 6 dB lower.
 *
 *   fn-rtl-gain -t
 *
 * runs the measurements on a signal made up in memory and says whether they came out
 * as they must. No dongle is needed.
 *
 * The exit status is 0 when everything asked for was measured.
 *
 * This program is free software; you can redistribute it and/or modify it under the
 * terms of the GNU General Public License as published by the Free Software Foundation,
 * either version 2 of the License, or (at your option) any later version.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <math.h>
#include <unistd.h>

#include <rtl-sdr.h>

#define MAX_FREQUENCIES 64
#define MAX_GAINS       64
#define MAX_CHANNELS    64

/* the share of samples at the ends of the converter's range that counts as too much */
#define TOO_MUCH        0.005

/* the overload check: the lower gain is at least this far down (tenths of a dB) */
#define COMPARE_DOWN    60
/* signals that change by amounts further apart than this (dB) are not treated alike */
#define DEPARTURE       6.0
/* a channel takes part in the comparison when it stands this far (dB) above the middle one */
#define STANDS_OUT      3.0
/* how much signal the comparison looks at, at each of the two gains */
#define COMPARE_MS      60

/* the survey: slices of this many samples per second, this far apart */
#define SURVEY_RATE     2400000
#define SLICE_STEP      2000000.0
#define SLICE_REACH     1000000.0
#define LISTEN_MS       800	/* at the gain found */
#define AGAIN_MS        400	/* at the lower gain */
/* a pilot below this (dB) is not asked for again at the lower gain */
#define PILOT_SEEN      6.0

#define NFFT            2048
#define FRAMES          128

#define PI              3.14159265358979323846

struct reading {
	double pilot;		/* the middle of the readings, dB */
	double low;		/* the least of them */
	double offset;		/* of the carrier from the channel's centre, Hz */
	int blocks;
};

static void usage(void)
{
	fprintf(stderr,
		"usage: fn-rtl-gain -f <Hz> [-f <Hz> ...] [-s <samples per second>] [-p <ppm>] [-d <device>]\n"
		"       fn-rtl-gain -b <low>:<high>:<spacing> [-p <ppm>] [-d <device>]\n"
		"       fn-rtl-gain -b <low>:<high>:<spacing> -r <file> -c <Hz> [-g <dB>] [-a <file>]\n"
		"       fn-rtl-gain -t\n");
}

/* A frequency as rtl_fm takes it: a number with an optional k, M or G */
static double scaled(const char *text)
{
	char *end = NULL;
	double value = strtod(text, &end);

	if (end != NULL) {
		switch (*end) {
		case 'k': case 'K': value *= 1e3; break;
		case 'm': case 'M': value *= 1e6; break;
		case 'g': case 'G': value *= 1e9; break;
		default: break;
		}
	}
	return value;
}

static int by_value(const void *a, const void *b)
{
	double x = *(const double *)a, y = *(const double *)b;

	return (x > y) - (x < y);
}

/* The value a share of the way up the sorted list (0.5: the middle one) */
static double ranked(const double *values, int count, double share)
{
	double sorted[MAX_CHANNELS];
	int at;

	if (count <= 0)
		return 0.0;
	if (count > MAX_CHANNELS)
		count = MAX_CHANNELS;
	memcpy(sorted, values, (size_t)count * sizeof(double));
	qsort(sorted, (size_t)count, sizeof(double), by_value);
	at = (int)(share * (count - 1) + 0.5);
	return sorted[at];
}

/* ---- the spectrum of a piece of signal ---- */

static void fft(float *re, float *im)
{
	static float cosine[NFFT / 2], sine[NFFT / 2];
	static int ready = 0;
	int i, j, length;

	if (!ready) {
		for (i = 0; i < NFFT / 2; i++) {
			cosine[i] = (float)cos(2.0 * PI * i / NFFT);
			sine[i] = (float)-sin(2.0 * PI * i / NFFT);
		}
		ready = 1;
	}
	for (i = 1, j = 0; i < NFFT; i++) {
		int bit = NFFT >> 1;

		for (; j & bit; bit >>= 1)
			j ^= bit;
		j ^= bit;
		if (i < j) {
			float t = re[i]; re[i] = re[j]; re[j] = t;
			t = im[i]; im[i] = im[j]; im[j] = t;
		}
	}
	for (length = 2; length <= NFFT; length <<= 1) {
		int half = length >> 1, stride = NFFT / length;

		for (i = 0; i < NFFT; i += length) {
			for (j = 0; j < half; j++) {
				float wr = cosine[j * stride], wi = sine[j * stride];
				float xr = re[i + j + half] * wr - im[i + j + half] * wi;
				float xi = re[i + j + half] * wi + im[i + j + half] * wr;

				re[i + j + half] = re[i + j] - xr;
				im[i + j + half] = im[i + j] - xi;
				re[i + j] += xr;
				im[i + j] += xi;
			}
		}
	}
}

/* The mean of the two halves of the signal: what the converter adds of its own */
static void rest_level(const uint8_t *iq, int pairs, double *mean_i, double *mean_q)
{
	double si = 0.0, sq = 0.0;
	int n;

	for (n = 0; n < pairs; n++) {
		si += iq[2 * n];
		sq += iq[2 * n + 1];
	}
	*mean_i = pairs > 0 ? si / pairs : 127.5;
	*mean_q = pairs > 0 ? sq / pairs : 127.5;
}

/*
 * The power spectrum of the signal: psd[k] is the mean square (in converter counts) at
 * (k - NFFT/2) * rate / NFFT from the centre. Returns 0 when there is too little signal.
 */
static int spectrum(const uint8_t *iq, int pairs, double *psd)
{
	static float window[NFFT];
	static double window_power = 0.0;
	float re[NFFT], im[NFFT];
	double mean_i, mean_q;
	int frames = pairs / NFFT;
	int stride, used = 0;
	int f, k;

	if (frames < 1)
		return 0;
	if (window_power == 0.0) {
		for (k = 0; k < NFFT; k++) {
			window[k] = (float)(0.5 - 0.5 * cos(2.0 * PI * k / (NFFT - 1)));
			window_power += (double)window[k] * window[k];
		}
	}
	rest_level(iq, pairs, &mean_i, &mean_q);
	for (k = 0; k < NFFT; k++)
		psd[k] = 0.0;
	stride = frames > FRAMES ? frames / FRAMES : 1;
	for (f = 0; f < frames; f += stride) {
		const uint8_t *from = iq + (size_t)f * NFFT * 2;

		for (k = 0; k < NFFT; k++) {
			re[k] = (float)((from[2 * k] - mean_i) * window[k]);
			im[k] = (float)((from[2 * k + 1] - mean_q) * window[k]);
		}
		fft(re, im);
		for (k = 0; k < NFFT; k++) {
			int shifted = (k + NFFT / 2) % NFFT;

			psd[shifted] += (double)re[k] * re[k] + (double)im[k] * im[k];
		}
		used++;
	}
	for (k = 0; k < NFFT; k++)
		psd[k] /= (double)used * NFFT * window_power;
	return 1;
}

/* The power between offset - half and offset + half (Hz from the centre), in dB */
static double band_power(const double *psd, double rate, double offset, double half)
{
	double sum = 0.0;
	int from = (int)floor((offset - half) / rate * NFFT + NFFT / 2 + 0.5);
	int to = (int)floor((offset + half) / rate * NFFT + NFFT / 2 + 0.5);
	int k;

	if (from < 0)
		from = 0;
	if (to > NFFT)
		to = NFFT;
	for (k = from; k < to; k++)
		sum += psd[k];
	return 10.0 * log10(sum + 1e-12);
}

/* ---- one channel out of a slice: is there a stereo station on it ---- */

#define TAPS_1          47	/* 2400000 -> 480000 */
#define TAPS_2          53	/* 480000 -> 240000 */
#define CHANNEL_RATE    240000
#define BLOCK           (CHANNEL_RATE / 8)
#define TONES           9
#define MAX_BLOCKS      16

static const double TONE[TONES] = {
	19000.0, 62000.0, 63500.0, 65000.0, 66500.0, 68000.0, 69500.0, 71000.0, 72500.0
};

/* A low-pass filter: cutoff as a share of the sample rate */
static void low_pass(float *taps, int count, double cutoff)
{
	double sum = 0.0;
	int k;

	for (k = 0; k < count; k++) {
		double x = k - (count - 1) / 2.0;
		double sinc = x == 0.0 ? 2.0 * cutoff : sin(2.0 * PI * cutoff * x) / (PI * x);
		double blackman = 0.42 - 0.5 * cos(2.0 * PI * k / (count - 1)) +
			0.08 * cos(4.0 * PI * k / (count - 1));

		taps[k] = (float)(sinc * blackman);
		sum += taps[k];
	}
	for (k = 0; k < count; k++)
		taps[k] = (float)(taps[k] / sum);
}

/*
 * Take the channel at offset Hz out of a slice sampled at SURVEY_RATE, demodulate it and
 * measure the pilot. Returns 0 when the piece is too short for one reading.
 */
static int listen(const uint8_t *iq, int pairs, double offset, struct reading *out)
{
	static float taps_1[TAPS_1], taps_2[TAPS_2], window[BLOCK];
	static double coefficient[TONES];
	static int ready = 0;
	float ring_1r[2 * TAPS_1], ring_1i[2 * TAPS_1];
	float ring_2r[2 * TAPS_2], ring_2i[2 * TAPS_2];
	double s1[TONES], s2[TONES];
	double readings[MAX_BLOCKS];
	double mean_i, mean_q;
	double rot_r = 1.0, rot_i = 0.0;
	double step_r, step_i;
	double last_r = 0.0, last_i = 0.0;
	double turned = 0.0;
	long outputs = 0;
	int at_1 = 0, at_2 = 0, phase_1 = 0, phase_2 = 0;
	int filled = 0, blocks = 0;
	int n, k, t;

	if (!ready) {
		low_pass(taps_1, TAPS_1, 190000.0 / SURVEY_RATE);
		low_pass(taps_2, TAPS_2, 110000.0 / 480000.0);
		for (k = 0; k < BLOCK; k++)
			window[k] = (float)(0.5 - 0.5 * cos(2.0 * PI * k / (BLOCK - 1)));
		for (t = 0; t < TONES; t++)
			coefficient[t] = 2.0 * cos(2.0 * PI * TONE[t] / CHANNEL_RATE);
		ready = 1;
	}
	memset(ring_1r, 0, sizeof(ring_1r));
	memset(ring_1i, 0, sizeof(ring_1i));
	memset(ring_2r, 0, sizeof(ring_2r));
	memset(ring_2i, 0, sizeof(ring_2i));
	for (t = 0; t < TONES; t++)
		s1[t] = s2[t] = 0.0;

	rest_level(iq, pairs, &mean_i, &mean_q);
	step_r = cos(-2.0 * PI * offset / SURVEY_RATE);
	step_i = sin(-2.0 * PI * offset / SURVEY_RATE);

	for (n = 0; n < pairs; n++) {
		double xr = iq[2 * n] - mean_i, xi = iq[2 * n + 1] - mean_q;
		double next;
		float yr, yi;

		/* the channel moved to the centre */
		ring_1r[at_1] = ring_1r[at_1 + TAPS_1] = (float)(xr * rot_r - xi * rot_i);
		ring_1i[at_1] = ring_1i[at_1 + TAPS_1] = (float)(xr * rot_i + xi * rot_r);
		at_1 = at_1 + 1 == TAPS_1 ? 0 : at_1 + 1;
		next = rot_r * step_r - rot_i * step_i;
		rot_i = rot_r * step_i + rot_i * step_r;
		rot_r = next;
		if ((n & 1023) == 0) {	/* kept on the unit circle */
			double size = sqrt(rot_r * rot_r + rot_i * rot_i);

			rot_r /= size;
			rot_i /= size;
		}
		if (++phase_1 < 5)
			continue;
		phase_1 = 0;

		/* every fifth sample: 480000 a second */
		yr = yi = 0.0f;
		for (k = 0; k < TAPS_1; k++) {
			yr += taps_1[k] * ring_1r[at_1 + k];
			yi += taps_1[k] * ring_1i[at_1 + k];
		}
		ring_2r[at_2] = ring_2r[at_2 + TAPS_2] = yr;
		ring_2i[at_2] = ring_2i[at_2 + TAPS_2] = yi;
		at_2 = at_2 + 1 == TAPS_2 ? 0 : at_2 + 1;
		if (++phase_2 < 2)
			continue;
		phase_2 = 0;

		/* every second of those: 240000 a second, the channel alone */
		yr = yi = 0.0f;
		for (k = 0; k < TAPS_2; k++) {
			yr += taps_2[k] * ring_2r[at_2 + k];
			yi += taps_2[k] * ring_2i[at_2 + k];
		}

		/* how far the signal turned since the sample before: the programme */
		{
			double turn = atan2(yi * last_r - yr * last_i, yr * last_r + yi * last_i);
			double shaped = turn * window[filled];

			last_r = yr;
			last_i = yi;
			turned += turn;
			outputs++;
			for (t = 0; t < TONES; t++) {
				double s0 = shaped + coefficient[t] * s1[t] - s2[t];

				s2[t] = s1[t];
				s1[t] = s0;
			}
		}
		if (++filled < BLOCK)
			continue;
		filled = 0;

		/* an eighth of a second: the pilot against the noise above the programme */
		{
			double power[TONES], noise = 0.0;

			for (t = 0; t < TONES; t++) {
				power[t] = s1[t] * s1[t] + s2[t] * s2[t] - coefficient[t] * s1[t] * s2[t];
				s1[t] = s2[t] = 0.0;
				if (t > 0)
					noise += power[t];
			}
			noise /= TONES - 1;
			if (blocks < MAX_BLOCKS && noise > 0.0 && power[0] > 0.0)
				readings[blocks++] = 10.0 * log10(power[0] / noise);
		}
	}

	if (blocks == 0)
		return 0;
	out->pilot = ranked(readings, blocks, 0.5);
	out->low = ranked(readings, blocks, 0.0);
	out->offset = turned / (double)outputs * CHANNEL_RATE / (2.0 * PI);
	out->blocks = blocks;
	return 1;
}

/* ---- the channels of a slice ---- */

struct slice {
	double centre;		/* Hz */
	double rate;
	double channel[MAX_CHANNELS];	/* Hz, rising, one spacing apart */
	int count;
	int first, last;	/* the channels reported; the ones outside are neighbours only */
};

/* The power on each channel of the slice, within half Hz of its centre, in dB */
static int channel_levels(const struct slice *slice, const uint8_t *iq, int pairs,
			  double half, double *level)
{
	static double psd[NFFT];
	int c;

	if (!spectrum(iq, pairs, psd))
		return 0;
	for (c = 0; c < slice->count; c++)
		level[c] = band_power(psd, slice->rate, slice->channel[c] - slice->centre, half);
	return 1;
}

/* Whether the channel holds more than both its neighbours */
static int is_top(const double *level, int count, int c)
{
	return c > 0 && c < count - 1 && level[c] >= level[c - 1] && level[c] >= level[c + 1];
}

/*
 * How unlike the signals of a slice change between two gains, in dB: 0 when every one
 * changes by the same amount. high and low are the channel levels at the two gains with
 * the gains taken off; always is a channel that takes part whatever it holds, or -1.
 */
static double departure(const double *high, const double *low, int count, int always)
{
	double change[MAX_CHANNELS];
	double middle_high = ranked(high, count, 0.5);
	double middle_low = ranked(low, count, 0.5);
	double reference, worst = 0.0;
	int used = 0;
	int c;

	for (c = 0; c < count; c++) {
		int stands = (is_top(high, count, c) && high[c] >= middle_high + STANDS_OUT) ||
			     (is_top(low, count, c) && low[c] >= middle_low + STANDS_OUT);

		if (stands || c == always)
			change[used++] = high[c] - low[c];
	}
	if (used == 0)
		return 0.0;
	/* with few signals the gain steps are taken at their word */
	reference = used >= 3 ? ranked(change, used, 0.5) : 0.0;
	for (c = 0; c < used; c++) {
		double away = fabs(change[c] - reference);

		if (away > worst)
			worst = away;
	}
	return worst;
}

/* ---- the dongle ---- */

struct tuner {
	rtlsdr_dev_t *dev;
	int gains[MAX_GAINS];
	int steps;
	uint32_t rate;
	uint8_t *block;		/* 16 ms of signal */
	int block_bytes;
	uint8_t *piece;		/* what the overload check and the survey look at */
	int piece_bytes;
};

/* Read so many bytes of signal; returns the number read, in whole samples */
static int capture(struct tuner *tuner, uint8_t *into, int bytes)
{
	int done = 0;

	while (done < bytes) {
		int want = bytes - done > 262144 ? 262144 : bytes - done;
		int got = 0;

		want -= want % 512;
		if (want == 0)
			break;
		if (rtlsdr_read_sync(tuner->dev, into + done, want, &got) < 0 || got <= 0)
			break;
		done += got;
	}
	return done - done % 2;
}

/* Set a gain step and wait until the signal is of that step */
static int set_step(struct tuner *tuner, int index)
{
	int got = 0;

	if (rtlsdr_set_tuner_gain(tuner->dev, tuner->gains[index]) < 0)
		return -1;
	usleep(20000);			/* the tuner settles */
	rtlsdr_reset_buffer(tuner->dev);
	/* the first block still holds samples of the step before */
	rtlsdr_read_sync(tuner->dev, tuner->block, tuner->block_bytes, &got);
	return 0;
}

/* Measure at one step: the share of samples at the ends of the range, and the mean level */
static int measure(struct tuner *tuner, int index, double *share, double *level)
{
	int got = 0;
	int ends = 0;
	double sum = 0.0;
	int i;

	if (set_step(tuner, index) < 0)
		return -1;
	if (rtlsdr_read_sync(tuner->dev, tuner->block, tuner->block_bytes, &got) < 0 ||
	    got < tuner->block_bytes / 2)
		return -1;

	for (i = 0; i < got; i++) {
		if (tuner->block[i] == 0 || tuner->block[i] == 255)
			ends++;
		sum += tuner->block[i] > 127 ? tuner->block[i] - 127.5 : 127.5 - tuner->block[i];
	}
	*share = (double)ends / got;
	*level = sum / got;
	return 0;
}

static int tune(struct tuner *tuner, uint32_t frequency)
{
	int result;

	/* with the gain as it suits a first tuning: an R828D needs it to lock */
	rtlsdr_set_tuner_gain_mode(tuner->dev, 0);
	result = rtlsdr_set_center_freq(tuner->dev, frequency);
	usleep(50000);
	rtlsdr_set_tuner_gain_mode(tuner->dev, 1);
	return result;
}

/*
 * The highest step at which next to no sample is cut off, starting the walk at *index.
 * Returns the step, or -1 when nothing could be read.
 */
static int highest_uncut(struct tuner *tuner, int index, double *share, double *level)
{
	int chosen = -1;
	int direction = 0;
	int walk;

	for (walk = 0; walk < tuner->steps; walk++) {
		double s = 0.0, l = 0.0;

		if (measure(tuner, index, &s, &l) < 0)
			break;
		if (s > TOO_MUCH) {		/* peaks cut off: less gain */
			if (direction > 0)
				break;		/* the step before, already chosen, is the one */
			if (index == 0) {
				chosen = 0;
				*share = s;
				*level = l;
				break;
			}
			direction = -1;
			index--;
		} else {			/* room left: this step will do, a higher one may too */
			chosen = index;
			*share = s;
			*level = l;
			if (direction < 0 || index == tuner->steps - 1)
				break;
			direction = 1;
			index++;
		}
	}
	return chosen;
}

/* The channel levels of the slice at a step, the gain taken off */
static int levels_at(struct tuner *tuner, const struct slice *slice, int index, double *level)
{
	int bytes = (int)((uint64_t)tuner->rate * 2 * COMPARE_MS / 1000);
	int got, c;

	bytes -= bytes % 512;
	if (bytes > tuner->piece_bytes)
		bytes = tuner->piece_bytes;
	if (set_step(tuner, index) < 0)
		return 0;
	got = capture(tuner, tuner->piece, bytes);
	if (got < bytes / 2 || !channel_levels(slice, tuner->piece, got / 2, 100000.0, level))
		return 0;
	for (c = 0; c < slice->count; c++)
		level[c] -= tuner->gains[index] / 10.0;
	return 1;
}

/* The step at least COMPARE_DOWN below, or -1 when the steps do not reach that far down */
static int step_below(const struct tuner *tuner, int index)
{
	int lower;

	for (lower = index - 1; lower >= 0; lower--)
		if (tuner->gains[index] - tuner->gains[lower] >= COMPARE_DOWN)
			return lower;
	return -1;
}

/*
 * Take the gain down from index until the tuner treats the signals of the slice alike.
 * Returns the step to use.
 */
static int not_overloaded(struct tuner *tuner, const struct slice *slice, int index, int always)
{
	double high[MAX_CHANNELS], low[MAX_CHANNELS];

	while (index > 0) {
		int lower = step_below(tuner, index);

		if (lower < 0)
			break;
		if (!levels_at(tuner, slice, index, high) || !levels_at(tuner, slice, lower, low))
			break;
		if (departure(high, low, slice->count, always) <= DEPARTURE)
			break;
		index--;
	}
	return index;
}

/* The gain for one slice: not cut off, not overloaded. Returns the step or -1. */
static int settle(struct tuner *tuner, const struct slice *slice, int start, int always,
		  double *share, double *level, int *backoff)
{
	int uncut = highest_uncut(tuner, start, share, level);
	int chosen;

	if (uncut < 0)
		return -1;
	chosen = not_overloaded(tuner, slice, uncut, always);
	*backoff = tuner->gains[uncut] - tuner->gains[chosen];
	if (chosen != uncut)
		measure(tuner, chosen, share, level);
	return chosen;
}

static int open_tuner(struct tuner *tuner, int device, uint32_t rate, int ppm, int piece_ms)
{
	memset(tuner, 0, sizeof(*tuner));
	if (rtlsdr_open(&tuner->dev, (uint32_t)device) < 0 || tuner->dev == NULL) {
		fprintf(stderr, "fn-rtl-gain: cannot open device %d\n", device);
		return -1;
	}
	if (rtlsdr_set_sample_rate(tuner->dev, rate) < 0) {
		fprintf(stderr, "fn-rtl-gain: cannot set %u samples per second\n", rate);
		rtlsdr_close(tuner->dev);
		return -1;
	}
	tuner->rate = rate;
	if (ppm != 0)
		rtlsdr_set_freq_correction(tuner->dev, ppm);

	tuner->steps = rtlsdr_get_tuner_gains(tuner->dev, NULL);
	if (tuner->steps <= 0 || tuner->steps > MAX_GAINS) {
		fprintf(stderr, "fn-rtl-gain: the tuner names no gain steps\n");
		rtlsdr_close(tuner->dev);
		return -1;
	}
	tuner->steps = rtlsdr_get_tuner_gains(tuner->dev, tuner->gains);

	/* 16 ms of signal at a step, in the multiples of 512 bytes the library reads */
	tuner->block_bytes = (int)(((uint64_t)rate * 2 * 16 / 1000 + 511) / 512) * 512;
	tuner->piece_bytes = (int)(((uint64_t)rate * 2 * piece_ms / 1000 + 511) / 512) * 512;
	tuner->block = malloc((size_t)tuner->block_bytes);
	tuner->piece = malloc((size_t)tuner->piece_bytes);
	if (tuner->block == NULL || tuner->piece == NULL) {
		rtlsdr_close(tuner->dev);
		return -1;
	}

	/* the gain is set by this program, not by the tuner or the converter */
	rtlsdr_set_agc_mode(tuner->dev, 0);
	rtlsdr_set_tuner_gain_mode(tuner->dev, 1);
	return 0;
}

static void close_tuner(struct tuner *tuner)
{
	free(tuner->block);
	free(tuner->piece);
	rtlsdr_close(tuner->dev);
}

static int first_step(const struct tuner *tuner)
{
	int index = tuner->steps * 4 / 5;

	return index >= tuner->steps ? tuner->steps - 1 : index;
}

/* ---- the gain for stations ---- */

/* The channels 100 kHz apart around a tuned frequency that the slice shows whole */
static void around(struct slice *slice, double frequency, double rate)
{
	int reach = (int)((rate / 2.0 - 150000.0) / 100000.0);
	int k;

	if (reach < 0)
		reach = 0;
	if (2 * reach + 1 > MAX_CHANNELS)
		reach = (MAX_CHANNELS - 1) / 2;
	slice->centre = frequency;
	slice->rate = rate;
	slice->count = 0;
	for (k = -reach; k <= reach; k++)
		slice->channel[slice->count++] = frequency + k * 100000.0;
	slice->first = 0;
	slice->last = slice->count - 1;
}

static int gains_for(const uint32_t *frequencies, int count, uint32_t rate, int ppm, int device)
{
	struct tuner tuner;
	struct slice slice;
	int lowest = -1;
	int failed = 0;
	int index, at;

	if (open_tuner(&tuner, device, rate, ppm, COMPARE_MS) < 0)
		return 1;
	index = first_step(&tuner);

	for (at = 0; at < count; at++) {
		double share = 0.0, level = 0.0;
		int backoff = 0;
		int chosen;

		tune(&tuner, frequencies[at]);
		around(&slice, frequencies[at], rate);
		chosen = settle(&tuner, &slice, index, slice.count / 2, &share, &level, &backoff);
		if (chosen < 0) {
			fprintf(stderr, "fn-rtl-gain: nothing could be read at %u Hz\n", frequencies[at]);
			failed = 1;
			continue;
		}
		printf("GAIN: freq=%u gain=%d.%d step=%d of=%d level=%.1f cut=%.2f backoff=%d.%d\n",
		       frequencies[at], tuner.gains[chosen] / 10, tuner.gains[chosen] % 10,
		       chosen + 1, tuner.steps, level, share * 100.0, backoff / 10, backoff % 10);
		fflush(stdout);
		if (lowest < 0 || chosen < lowest)
			lowest = chosen;
		index = chosen;		/* the next frequency starts where this one ended */
	}

	if (count > 1 && lowest >= 0)
		printf("BAND: gain=%d.%d step=%d of=%d\n",
		       tuner.gains[lowest] / 10, tuner.gains[lowest] % 10, lowest + 1, tuner.steps);

	close_tuner(&tuner);
	return failed;
}

/* ---- the survey ---- */

struct band {
	double low, high, spacing;
};

/* The centre of the first slice: half a spacing off the channels, so that none lies on it */
static double first_centre(const struct band *band)
{
	return band->low + SLICE_REACH - band->spacing / 2.0;
}

/* The channels of the band a slice holds, with a neighbour on either side */
static void slice_channels(struct slice *slice, const struct band *band, double centre)
{
	int total = (int)floor((band->high - band->low) / band->spacing + 1e-6);
	int k;

	slice->centre = centre;
	slice->rate = SURVEY_RATE;
	slice->count = 0;
	slice->first = slice->last = -1;
	for (k = -1; k <= total + 1 && slice->count < MAX_CHANNELS; k++) {
		double frequency = band->low + k * band->spacing;

		if (fabs(frequency - centre) >= SLICE_REACH + band->spacing)
			continue;
		if (k >= 0 && k <= total && fabs(frequency - centre) < SLICE_REACH) {
			if (slice->first < 0)
				slice->first = slice->count;
			slice->last = slice->count;
		}
		slice->channel[slice->count++] = frequency;
	}
}

/*
 * Report a slice from a piece of its signal: the line that names the slice, begun by the
 * caller in heading, and its channels. again is the same slice with the gain lower, or
 * NULL when there is none.
 */
static void report(const struct slice *slice, const char *heading, const uint8_t *iq, int pairs,
		   double gain, const uint8_t *again, int again_pairs)
{
	double level[MAX_CHANNELS];
	int c;

	if (slice->first < 0 || !channel_levels(slice, iq, pairs, 75000.0, level))
		return;
	for (c = 0; c < slice->count; c++)
		level[c] -= gain;
	printf("%s floor=%.1f\n", heading,
	       ranked(level + slice->first, slice->last - slice->first + 1, 0.2));

	for (c = slice->first; c <= slice->last; c++) {
		struct reading heard, held;
		int top = is_top(level, slice->count, c);

		printf("CHANNEL: freq=%.0f rf=%.1f top=%d", slice->channel[c], level[c], top);
		if (top && listen(iq, pairs, slice->channel[c] - slice->centre, &heard)) {
			printf(" pilot=%.1f low=%.1f offset=%.0f", heard.pilot, heard.low, heard.offset);
			if (again != NULL && heard.pilot >= PILOT_SEEN &&
			    listen(again, again_pairs, slice->channel[c] - slice->centre, &held))
				printf(" again=%.1f", held.pilot);
			else
				printf(" again=-");
		}
		printf("\n");
		fflush(stdout);
	}
}

static int survey(const struct band *band, int ppm, int device)
{
	struct tuner tuner;
	struct slice slice;
	uint8_t *again;
	double centre;
	int again_bytes = (int)((uint64_t)SURVEY_RATE * 2 * AGAIN_MS / 1000);
	int failed = 0;
	int index;

	if (open_tuner(&tuner, device, SURVEY_RATE, ppm, LISTEN_MS) < 0)
		return 1;
	again = malloc((size_t)again_bytes);
	if (again == NULL) {
		close_tuner(&tuner);
		return 1;
	}
	index = first_step(&tuner);

	for (centre = first_centre(band); centre - SLICE_REACH < band->high + band->spacing / 2.0;
	     centre += SLICE_STEP) {
		char heading[200];
		double share = 0.0, level = 0.0;
		int backoff = 0;
		int chosen, lower, got, got_again = 0;

		slice_channels(&slice, band, centre);
		if (slice.first < 0)
			continue;
		tune(&tuner, (uint32_t)centre);
		chosen = settle(&tuner, &slice, index, -1, &share, &level, &backoff);
		if (chosen < 0) {
			fprintf(stderr, "fn-rtl-gain: nothing could be read at %.0f Hz\n", centre);
			failed = 1;
			continue;
		}
		index = chosen;

		if (set_step(&tuner, chosen) < 0 ||
		    (got = capture(&tuner, tuner.piece, tuner.piece_bytes)) < tuner.piece_bytes / 2) {
			fprintf(stderr, "fn-rtl-gain: the signal at %.0f Hz could not be read\n", centre);
			failed = 1;
			continue;
		}
		lower = step_below(&tuner, chosen);
		if (lower >= 0 && set_step(&tuner, lower) == 0)
			got_again = capture(&tuner, again, again_bytes);

		snprintf(heading, sizeof(heading),
			 "SLICE: freq=%.0f gain=%d.%d step=%d of=%d level=%.1f cut=%.2f backoff=%d.%d",
			 centre, tuner.gains[chosen] / 10, tuner.gains[chosen] % 10, chosen + 1,
			 tuner.steps, level, share * 100.0, backoff / 10, backoff % 10);
		report(&slice, heading, tuner.piece, got / 2, tuner.gains[chosen] / 10.0,
		       got_again >= again_bytes / 2 ? again : NULL, got_again / 2);
	}

	free(again);
	close_tuner(&tuner);
	return failed;
}

/* A recording made with rtl_sdr: at most so many bytes of it. Returns NULL when it holds too little. */
static uint8_t *recorded(const char *path, long most, long *size)
{
	FILE *file = fopen(path, "rb");
	uint8_t *iq;

	if (file == NULL) {
		fprintf(stderr, "fn-rtl-gain: cannot read %s\n", path);
		return NULL;
	}
	fseek(file, 0, SEEK_END);
	*size = ftell(file);
	fseek(file, 0, SEEK_SET);
	if (*size > most)
		*size = most;
	*size -= *size % 2;
	iq = malloc((size_t)(*size > 0 ? *size : 2));
	if (iq == NULL || *size < NFFT * 2 || fread(iq, 1, (size_t)*size, file) != (size_t)*size) {
		fprintf(stderr, "fn-rtl-gain: %s holds too little signal\n", path);
		free(iq);
		iq = NULL;
	}
	fclose(file);
	return iq;
}

/* The same on one slice that was recorded, and on a second recording of it with the gain lower */
static int survey_file(const struct band *band, const char *path, const char *lower_path,
		       double centre, double gain)
{
	struct slice slice;
	char heading[200];
	uint8_t *iq, *again = NULL;
	long size = 0, again_size = 0;

	/* as much as the survey listens to */
	iq = recorded(path, (long)((int64_t)SURVEY_RATE * 2 * LISTEN_MS / 1000), &size);
	if (iq == NULL)
		return 1;
	if (lower_path != NULL)
		again = recorded(lower_path, (long)((int64_t)SURVEY_RATE * 2 * AGAIN_MS / 1000), &again_size);

	slice_channels(&slice, band, centre);
	if (slice.first < 0) {
		fprintf(stderr, "fn-rtl-gain: no channel of the band lies in a slice at %.0f Hz\n", centre);
		free(iq);
		free(again);
		return 1;
	}
	snprintf(heading, sizeof(heading),
		 "SLICE: freq=%.0f gain=%.1f step=0 of=0 level=0.0 cut=0.00 backoff=0.0", centre, gain);
	report(&slice, heading, iq, (int)(size / 2), gain, again, (int)(again_size / 2));
	free(iq);
	free(again);
	return 0;
}

/* ---- the measurements tried on a signal made up here ---- */

struct made {
	double offset;		/* Hz from the centre */
	double size;		/* converter counts */
	int pilot;		/* a stereo station */
};

/* A slice with FM stations in it, and noise */
static void make_slice(uint8_t *iq, int pairs, const struct made *stations, int count, double scale)
{
	double phase[8] = { 0 };
	uint32_t seed = 12345;
	int n, s;

	for (n = 0; n < pairs; n++) {
		double t = (double)n / SURVEY_RATE;
		double re = 0.0, im = 0.0;

		for (s = 0; s < count && s < 8; s++) {
			/* a tone of 1 kHz as the programme, and the pilot at its usual strength */
			double swing = 40000.0 * sin(2.0 * PI * (1000.0 + 150.0 * s) * t) +
				(stations[s].pilot ? 6750.0 * sin(2.0 * PI * 19000.0 * t) : 0.0);

			phase[s] += 2.0 * PI * (stations[s].offset + swing) / SURVEY_RATE;
			if (phase[s] > PI)
				phase[s] -= 2.0 * PI;
			re += stations[s].size * scale * cos(phase[s]);
			im += stations[s].size * scale * sin(phase[s]);
		}
		seed = seed * 1664525u + 1013904223u;
		re += ((seed >> 16) % 7) - 3.0;
		seed = seed * 1664525u + 1013904223u;
		im += ((seed >> 16) % 7) - 3.0;
		re = floor(re + 128.0);
		im = floor(im + 128.0);
		iq[2 * n] = (uint8_t)(re < 0 ? 0 : re > 255 ? 255 : re);
		iq[2 * n + 1] = (uint8_t)(im < 0 ? 0 : im > 255 ? 255 : im);
	}
}

static int self_test(void)
{
	/* a stereo station, a carrier without a pilot, and a second stereo station */
	static const struct made stations[] = {
		{ 350000.0, 30.0, 1 }, { -450000.0, 20.0, 0 }, { -850000.0, 12.0, 1 }
	};
	static const struct band band = { 99500000.0, 101400000.0, 100000.0 };
	struct slice slice;
	struct reading stereo, plain, empty;
	double level[MAX_CHANNELS], high[MAX_CHANNELS], low[MAX_CHANNELS];
	int pairs = SURVEY_RATE * 4 / 10;
	int brief = SURVEY_RATE * COMPARE_MS / 1000;
	uint8_t *iq = malloc((size_t)pairs * 2);
	uint8_t *other = malloc((size_t)brief * 2);
	double alike, unlike;
	int failed = 0;
	int c, top_stereo = -1, top_plain = -1;

	if (iq == NULL || other == NULL)
		return 1;
	slice_channels(&slice, &band, 100450000.0);
	make_slice(iq, pairs, stations, 3, 1.0);
	channel_levels(&slice, iq, pairs, 75000.0, level);
	for (c = slice.first; c <= slice.last; c++) {
		if (fabs(slice.channel[c] - 100800000.0) < 1.0 && is_top(level, slice.count, c))
			top_stereo = c;
		if (fabs(slice.channel[c] - 100000000.0) < 1.0 && is_top(level, slice.count, c))
			top_plain = c;
	}
	if (top_stereo < 0 || top_plain < 0) {
		printf("selftest: the stations do not stand above their neighbours\n");
		failed = 1;
	}
	if (!listen(iq, pairs, 350000.0, &stereo) || stereo.pilot < 25.0 || stereo.low < 20.0 ||
	    fabs(stereo.offset) > 2000.0) {
		printf("selftest: stereo station: pilot %.1f low %.1f offset %.0f\n",
		       stereo.pilot, stereo.low, stereo.offset);
		failed = 1;
	}
	if (!listen(iq, pairs, -450000.0, &plain) || plain.pilot > 6.0) {
		printf("selftest: carrier without pilot: pilot %.1f\n", plain.pilot);
		failed = 1;
	}
	if (!listen(iq, pairs, 150000.0, &empty) || empty.pilot > 6.0) {
		printf("selftest: empty channel: pilot %.1f\n", empty.pilot);
		failed = 1;
	}

	/* the same slice with every signal 6 dB down: treated alike */
	channel_levels(&slice, iq, brief, 100000.0, high);
	make_slice(other, brief, stations, 3, 0.5);
	channel_levels(&slice, other, brief, 100000.0, low);
	for (c = 0; c < slice.count; c++)
		low[c] += 6.0;
	alike = departure(high, low, slice.count, -1);
	/* and with one of them gone, as a signal the tuner made is: not alike */
	make_slice(other, brief, stations, 2, 0.5);
	channel_levels(&slice, other, brief, 100000.0, low);
	for (c = 0; c < slice.count; c++)
		low[c] += 6.0;
	unlike = departure(high, low, slice.count, -1);
	if (alike > DEPARTURE / 2.0 || unlike <= DEPARTURE) {
		printf("selftest: overload check: %.1f dB for signals treated alike, %.1f dB for unlike\n",
		       alike, unlike);
		failed = 1;
	}

	free(iq);
	free(other);
	if (failed)
		printf("selftest: failed\n");
	else
		printf("selftest: ok (pilot %.1f dB, none %.1f dB, alike %.1f dB, unlike %.1f dB)\n",
		       stereo.pilot, plain.pilot, alike, unlike);
	return failed;
}

int main(int argc, char **argv)
{
	uint32_t frequencies[MAX_FREQUENCIES];
	struct band band = { 0.0, 0.0, 0.0 };
	const char *recording = NULL;
	const char *recording_lower = NULL;
	double centre = 0.0, recorded_gain = 0.0;
	int count = 0;
	uint32_t rate = 1200000;
	int ppm = 0;
	int device = 0;
	int test = 0;
	int option;

	while ((option = getopt(argc, argv, "f:s:p:d:b:r:a:c:g:th")) != -1) {
		switch (option) {
		case 'f':
			if (count < MAX_FREQUENCIES)
				frequencies[count++] = (uint32_t)scaled(optarg);
			break;
		case 's':
			rate = (uint32_t)scaled(optarg);
			break;
		case 'p':
			ppm = atoi(optarg);
			break;
		case 'd':
			device = atoi(optarg);
			break;
		case 'b': {
			char *second = strchr(optarg, ':');
			char *third = second ? strchr(second + 1, ':') : NULL;

			if (third == NULL) {
				usage();
				return 2;
			}
			band.low = scaled(optarg);
			band.high = scaled(second + 1);
			band.spacing = scaled(third + 1);
			break;
		}
		case 'r':
			recording = optarg;
			break;
		case 'a':
			recording_lower = optarg;
			break;
		case 'c':
			centre = scaled(optarg);
			break;
		case 'g':
			recorded_gain = atof(optarg);
			break;
		case 't':
			test = 1;
			break;
		default:
			usage();
			return 2;
		}
	}

	if (test)
		return self_test();
	if (band.spacing != 0.0 || band.low != 0.0) {
		if (band.spacing < 50000.0 || band.spacing > 400000.0 || band.high <= band.low ||
		    band.high - band.low > 40e6) {
			usage();
			return 2;
		}
		if (recording != NULL)
			return centre > 0.0 ? survey_file(&band, recording, recording_lower, centre, recorded_gain) : (usage(), 2);
		return survey(&band, ppm, device);
	}
	if (count == 0 || rate < 225001 || rate > 3200000) {
		usage();
		return 2;
	}
	return gains_for(frequencies, count, rate, ppm, device);
}
