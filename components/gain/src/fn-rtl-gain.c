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
 * that are. A receiver that is not overloaded shows the same signals, each as strong
 * against the others, whatever its gain; an overloaded one does not. So the slice is
 * first looked at with a gain far below the one found, where the tuner has room to
 * spare, and the gain taken is the highest at which the slice still looks like that.
 * (Comparing with a gain only a little lower will not do: a tuner deep in overload
 * shows the same false picture at both.)
 *
 * The tuner's own automatic gain is not used: measured, it leaves a large share of the
 * samples cut off.
 *
 * A tuner that mixes the band straight down to zero (an E4000) leaves noise of its own
 * around the frequency it is set to, tens of kilohertz wide, and that noise does not
 * follow the gain: at a low gain it stands above everything near it, at a high gain it
 * is hardly there. To a check that asks whether signals keep their strength against one
 * another when the gain changes it looks like a signal the tuner made, and the gain was
 * taken down by 15 dB for it. The 25 kHz either side of the tuning point are therefore
 * left out of every level. (The library can set such a tuner beside the band it
 * delivers. That was tried and is not used: it moves the noise out, but the mirror
 * described below then comes from stations 3 to 5 MHz away, where a survey cannot see
 * what it is the mirror of.)
 *
 *   fn-rtl-gain -f <Hz> [-f <Hz> ...] [-s <samples per second>] [-p <ppm>] [-d <device>]
 *
 * measures the slice the receiver will take in for that station: -s is the rate the
 * receiver reads the dongle at, and the tuner is set a quarter of it above the station,
 * as rtl_fm sets it. (Measured on 1.2 MHz around the station while the receiver took in
 * 1.9 MHz to one side, a strong station inside the receiver's slice and outside the
 * measured one went unseen: 80% of the samples were cut off at the gain found.) It
 * prints one line for each frequency
 *   GAIN: freq=<Hz> gain=<dB> step=<n> of=<n> level=<mean of 127> cut=<percent> backoff=<dB>
 * (backoff: how far the gain was taken down because the tuner was overloaded) and, when
 * more than one frequency was given, the gain that suits them all:
 *   BAND: gain=<dB> step=<n> of=<n>
 *
 *   fn-rtl-gain -b <low>:<high>:<spacing> [-e] [-n <Hz> ...] [-p <ppm>] [-d <device>]
 *
 * surveys a band of FM broadcast channels, low to high in steps of spacing. The band is
 * taken in slices of 2 MHz, each at its own gain, and every channel is measured:
 *   SLICE: freq=<Hz> gain=<dB> step=<n> of=<n> level=<mean of 127> cut=<percent> backoff=<dB> floor=<dB>
 *   CHANNEL: freq=<Hz> rf=<dB> top=<0|1> [pilot=<dB> low=<dB> offset=<Hz> quiet=<dB> swing=<kHz> wide=<percent>
 *            [narrow=<dB>] [own=<dB>] again=<dB>|-> [againq=<dB> agains=<kHz>]
 *            [mirror=<share> moved=<dB>|-> [least=<dB> movedq=<dB>]]]
 * rf is the power in the channel, referred to the aerial socket (the gain taken off), on
 * a scale of its own; top says that the channel is listened to. Without -e that is a
 * channel that stands out: it holds at least what lies 100 kHz either side of it (one
 * channel either side on a raster finer than that), measured where a station keeps
 * most of its power, within 25 kHz of its carrier. A weak station does not show in the
 * power at all, only in its pilot, and is then found where chance makes its channel
 * stand out of the noise. With -e (every channel) all are listened to but those that
 * are one of a neighbour's, which holds 15 dB more: a survey half as long again, that
 * finds the weak stations every time. A channel named with -n is listened to either
 * way (the stations a list holds already), and so are the channels within 100 kHz of
 * a faint pilot, which may be heard from the channel next to the station's own. A
 * channel that is top is demodulated, taken in
 * 85 kHz either side of its centre, and the 19 kHz pilot every stereo station sends is
 * measured against the noise above the programme (62 to 73 kHz): pilot is the middle
 * of the readings, low the least of them, offset how far the carrier lies from the
 * channel's centre. narrow is a faint pilot (under 25 dB) read once more with the
 * channel taken in 55 kHz either side: a weak station reads better so, the spill of a
 * strong station 200 kHz away, which carries that station's pilot, reads worse. own is
 * how far the power at the channel's centre stands above the higher of the two places
 * 50 kHz either side of it (each 25 kHz wide): a station's power peaks at its carrier,
 * by 1 to 5 dB for a weak one, while a channel that only hears the station on the
 * channel next to it has no peak of its own (0.5 dB at most). It is what tells two
 * weak stations 100 kHz apart from one station heard on two channels. again
 * is the pilot once more with the gain about 6 dB lower: a station keeps its pilot, a
 * signal the tuner manufactured does not, and neither does a reading of noise that
 * happened to look like one.
 *
 * A station that sends no pilot (mono) is measured too, by its carrier. quiet is how far
 * a pilot of the usual strength (6.75 kHz of swing) would stand above the noise the
 * station shows: on the scale of pilot, and within a decibel of it for the stereo
 * stations it was tried on, but there whether a pilot is sent or not. It says little
 * below about 25 dB: a channel with no carrier in it reads 17 to 23. swing is how far
 * the programme swings the carrier (kHz, rms, of what lies below some 10 kHz of the
 * demodulated signal, where the programme is and little of the noise) and wide the
 * share of the time the carrier is more than 95 kHz from its place: a broadcast swings
 * 10 to 40 kHz and never that far, a bare carrier does not swing, noise and a signal
 * the tuner made by doubling a station's frequency go twice as far. againq and movedq
 * are quiet at the second looks, agains the swing at the look with the gain lower: a
 * station that was silent at the first look may not be at the second.
 *
 * The noise is read between 62 and 73 kHz of the demodulated signal, where a station
 * sends nothing. Some do: a subsidiary carrier at 67 kHz, common in the Americas, sits
 * exactly there, and such a station read 18 dB at any strength. Where that band holds
 * ten times what 76 to 83 kHz holds (referred to the same frequency: noise rises with
 * the square of it), the noise is read from the higher band instead.
 *
 * A tuner that mixes the band straight down to zero (an E4000) delivers every signal a
 * second time, weaker and turned over, as far on the other side of the frequency it is
 * set to. Such a copy of a strong station carries that station's pilot, and it stays at
 * any gain. A channel is therefore held against the one at its mirror place: where that
 * one holds more, and the channel is to a share that noise never reaches the turned-over
 * copy of it (mirror, 0 to 1), the channel is listened to once more with the tuner set
 * half a megahertz beside it. A station is still there then (moved: its pilot, least:
 * the least of the readings, as pilot and low of the first look), a copy is not. moved
 * is - when the second look could not tell either.
 *
 *   fn-rtl-gain -b <low>:<high>:<spacing> [-e] [-n <Hz> ...] -r <file> -c <Hz> [-g <dB>] [-a <file> [-l <dB>]]
 *               [-m <file> -k <Hz>]
 *
 * does the same on one slice recorded with rtl_sdr at 2400000 samples per second and
 * centred on -c, instead of a dongle; -g is the gain it was recorded with, -a a second
 * recording of the slice with a lower gain, -m a recording with the tuner set elsewhere
 * (centred on -k) for the second look at a channel that may be a mirror. With the gain
 * of the second recording named (-l) the overload check is made on the two as well:
 *   COMPARE: gain=<dB> against=<dB> departure=<dB>
 * (a departure above 6 dB: the slice does not look the same at the two gains).
 *
 *   fn-rtl-gain -t
 *
 * runs the measurements on a signal made up in memory and says whether they came out
 * as they must. No dongle is needed.
 *
 * The exit status is 0 when everything asked for was measured, and 3 when the dongle
 * opened and then delivered no samples.
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
#include <signal.h>

#include <rtl-sdr.h>

#define MAX_FREQUENCIES 64
#define MAX_GAINS       64
#define MAX_CHANNELS    64

/* the share of samples at the ends of the converter's range that counts as too much */
#define TOO_MUCH        0.005

/* the overload check: the gain the slice is compared with lies this far down (tenths of a dB) */
#define REFERENCE_DOWN  200
/* signals that differ from it by amounts further apart than this (dB) are not treated alike */
#define DEPARTURE       6.0
/* a channel is judged when it stands this far (dB) above the noise of the low gain */
#define JUDGED          6.0
/* stations rising this much less (dB) than the gain is named to have risen are held down by a tuner driven too hard */
#define HELD_DOWN       12.0
/* how much signal the comparison looks at, at each gain */
#define COMPARE_MS      60
/* the pilot is measured again with the gain at least this far down (tenths of a dB) */
#define AGAIN_DOWN      60

/* the survey: slices of this many samples per second, this far apart */
#define SURVEY_RATE     2400000
#define SLICE_STEP      2000000.0
#define SLICE_REACH     1000000.0
#define LISTEN_MS       800	/* at the gain found */
#define AGAIN_MS        800	/* at the lower gain: as long as at the gain found, to be judged alike */
/* a pilot below this (dB) is not asked for again at the lower gain: the least any setting takes for a station */
#define PILOT_SEEN      3.0
/* a carrier clear enough of the noise to be a station without a pilot: looked at twice as a pilot is */
#define QUIET_SEEN      25.0
/* a channel that may be the tuner's mirror of another: this share of it is that one turned over, */
#define MIRROR_SEEN     0.2
/* and that one holds this much more (dB) */
#define MIRROR_STRONGER 6.0
/* the tuner is set this far beside such a channel for the second look */
#define MOVED_BY        450000.0
/* a tuner's own noise around the frequency it is set to: this far either side is left out of a level */
#define ZERO_GUARD      25000.0
/* a station keeps most of its power within this of its carrier (two thirds to nine tenths, measured) */
#define CORE_HALF       25000.0
/* and reaches about this far: a channel is held against what lies there */
#define REACH           100000.0
/*
 * Surveying every channel (-e), a channel is one of a neighbour's, not listened to,
 * when the neighbour holds this much more close to the carrier (dB): nothing is
 * received that close to a station that much stronger. Less, and it is listened to: a
 * weak station does not show in the power at all, only in its pilot, and 200 kHz from
 * a strong station the place between them holds that station's spill, which is more
 * than the weak one's own.
 */
#define CLEARLY_MORE    15.0
/* a channel's own peak: the power this far either side of its centre, against that as far either side of the places OWN_SIDE away */
#define OWN_HALF        12500.0
#define OWN_SIDE        50000.0
/* how much more a neighbour may hold of a channel that is listened to: none, or CLEARLY_MORE with -e */
static double may_hold_more = 0.0;
/* the channels listened to whatever they hold (-n), Hz */
#define MAX_NAMED       256
static double named[MAX_NAMED];
static int named_count = 0;

#define NFFT            2048
#define FRAMES          128

#define PI              3.14159265358979323846

struct reading {
	double pilot;		/* the middle of the readings, dB */
	double low;		/* the least of them */
	double offset;		/* of the carrier from the channel's centre, Hz */
	double quiet;		/* a pilot of the usual strength over the noise, dB: the middle of the readings */
	double swing;		/* how far the programme swings the carrier, kHz rms */
	double wide;		/* the share of the time it is more than TOO_WIDE from its place, percent */
	int upper;		/* the noise was read above a subsidiary carrier */
	int blocks;
};

static void usage(void)
{
	fprintf(stderr,
		"usage: fn-rtl-gain -f <Hz> [-f <Hz> ...] [-s <samples per second>] [-p <ppm>] [-d <device>]\n"
		"       fn-rtl-gain -b <low>:<high>:<spacing> [-e] [-n <Hz> ...] [-p <ppm>] [-d <device>]\n"
		"       fn-rtl-gain -b <low>:<high>:<spacing> [-e] [-n <Hz> ...] -r <file> -c <Hz> [-g <dB>]\n"
		"                   [-a <file> [-l <dB>]] [-m <file> -k <Hz>]\n"
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
	int guard = (int)ceil(ZERO_GUARD / rate * NFFT);
	int k;

	if (from < 0)
		from = 0;
	if (to > NFFT)
		to = NFFT;
	for (k = from; k < to; k++) {
		/* not the tuner's own noise around the point it is set to */
		if (k > NFFT / 2 - guard && k < NFFT / 2 + guard)
			continue;
		sum += psd[k];
	}
	return 10.0 * log10(sum + 1e-12);
}

/* ---- one channel out of a slice: is there a stereo station on it ---- */

#define TAPS_1          47	/* 2400000 -> 480000 */
#define TAPS_2          53	/* 480000 -> 240000 */
/*
 * How far either side of its centre a channel is taken in, Hz: about what the receiver
 * takes in when the station is played. Wider, and a station is heard from the channel
 * next to its own as well as on it, and a weak one is heard less well on its own
 * (some 2 dB of pilot at 110 kHz against this).
 */
#define CHANNEL_HALF    85000.0
/*
 * And narrower, Hz, for a second opinion on a faint pilot. A station too weak for the
 * receiver to hold reads better through a narrower filter, which lets less noise in
 * (1 to 7 dB at this width, on the weak stations of one band). What a strong station
 * spills 200 kHz from its carrier carries its pilot too, but lies to one side of the
 * channel and comes and goes with the programme: the narrower filter takes most of it
 * away, and that pilot reads 3 to 9 dB worse.
 */
#define NARROW_HALF     55000.0
/* a pilot from here on (dB) is not faint: it is given no second opinion */
#define PLAIN_PILOT     25.0
#define CHANNEL_RATE    240000
#define BLOCK           (CHANNEL_RATE / 8)
#define TONES           14
#define LOWER_TONES     8	/* 62 to 72.5 kHz: where the noise is read */
#define MAX_BLOCKS      16
/* the lower band holding this many times the upper one's noise holds a subsidiary carrier */
#define OCCUPIED        10.0
/* the swing of a pilot of the usual strength, Hz */
#define PILOT_SWING     6750.0
/* a broadcast never swings further than this from its place, Hz (75 kHz allowed, some go to 90) */
#define TOO_WIDE        95000.0
/*
 * The programme is told from the noise by its place: summed over this many samples,
 * three times over, the demodulated signal keeps what lies below some 10 kHz and loses
 * what lies above 30 kHz, where the noise of a weak signal is (it rises with the square
 * of the frequency). One value is kept of every so many.
 */
#define PROGRAMME_SPAN  8

static const double TONE[TONES] = {
	19000.0, 62000.0, 63500.0, 65000.0, 66500.0, 68000.0, 69500.0, 71000.0, 72500.0,
	76500.0, 78000.0, 79500.0, 81000.0, 82500.0
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
static float taps_1[TAPS_1], taps_2[TAPS_2], taps_narrow[TAPS_2];
/* the filter a channel is taken in through: taps_2, or taps_narrow for the second opinion */
static const float *stage_2 = taps_2;
/*
 * Where a look reads the noise: NOISE_FOUND by what it finds, or where the first look
 * at the channel read it. Looks at one channel are held against each other, and are
 * read alike.
 */
#define NOISE_FOUND     -1
static int noise_from = NOISE_FOUND;

static void filters(void)
{
	static int ready = 0;

	if (!ready) {
		low_pass(taps_1, TAPS_1, 190000.0 / SURVEY_RATE);
		low_pass(taps_2, TAPS_2, CHANNEL_HALF / 480000.0);
		low_pass(taps_narrow, TAPS_2, NARROW_HALF / 480000.0);
		ready = 1;
	}
}

static int listen(const uint8_t *iq, int pairs, double offset, struct reading *out)
{
	static float window[BLOCK];
	static double coefficient[TONES], refer[TONES];
	static double usual_pilot = 0.0;
	static int ready = 0;
	double quiets[MAX_BLOCKS];
	double pilots[MAX_BLOCKS], lowers[MAX_BLOCKS], uppers[MAX_BLOCKS];
	double span_1[PROGRAMME_SPAN], span_2[PROGRAMME_SPAN], span_3[PROGRAMME_SPAN];
	double sum_1 = 0.0, sum_2 = 0.0, sum_3 = 0.0;
	double programme = 0.0, programme_square = 0.0;
	long programmes = 0;
	int span_at = 0;
	double lower_sum = 0.0, upper_sum = 0.0;
	double too_wide = 2.0 * PI * TOO_WIDE / CHANNEL_RATE;
	long wide = 0;
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

	filters();
	if (!ready) {
		double sum = 0.0;

		for (k = 0; k < BLOCK; k++) {
			window[k] = (float)(0.5 - 0.5 * cos(2.0 * PI * k / (BLOCK - 1)));
			sum += window[k];
		}
		for (t = 0; t < TONES; t++) {
			coefficient[t] = 2.0 * cos(2.0 * PI * TONE[t] / CHANNEL_RATE);
			/* noise rises with the square of the frequency: every place referred to 67 kHz */
			refer[t] = t == 0 ? 1.0 : (67000.0 / TONE[t]) * (67000.0 / TONE[t]);
		}
		/* what a tone of the usual pilot's swing shows in a block */
		usual_pilot = 2.0 * PI * PILOT_SWING / CHANNEL_RATE * sum / 2.0;
		usual_pilot *= usual_pilot;
		ready = 1;
	}
	memset(ring_1r, 0, sizeof(ring_1r));
	memset(ring_1i, 0, sizeof(ring_1i));
	memset(ring_2r, 0, sizeof(ring_2r));
	memset(ring_2i, 0, sizeof(ring_2i));
	for (t = 0; t < TONES; t++)
		s1[t] = s2[t] = 0.0;
	for (k = 0; k < PROGRAMME_SPAN; k++)
		span_1[k] = span_2[k] = span_3[k] = 0.0;

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
			yr += stage_2[k] * ring_2r[at_2 + k];
			yi += stage_2[k] * ring_2i[at_2 + k];
		}

		/* how far the signal turned since the sample before: the programme */
		{
			double turn = atan2(yi * last_r - yr * last_i, yr * last_r + yi * last_i);
			double shaped = turn * window[filled];

			last_r = yr;
			last_i = yi;
			turned += turn;
			if (turn > too_wide || turn < -too_wide)
				wide++;
			outputs++;
			/* the programme: three sums of the last samples, one of the other */
			sum_1 += turn - span_1[span_at];
			span_1[span_at] = turn;
			sum_2 += sum_1 - span_2[span_at];
			span_2[span_at] = sum_1;
			sum_3 += sum_2 - span_3[span_at];
			span_3[span_at] = sum_2;
			if (++span_at == PROGRAMME_SPAN) {
				double value = sum_3 / (PROGRAMME_SPAN * PROGRAMME_SPAN * PROGRAMME_SPAN);

				span_at = 0;
				programme += value;
				programme_square += value * value;
				programmes++;
			}
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
			double power[TONES], noise = 0.0, upper = 0.0;

			for (t = 0; t < TONES; t++) {
				power[t] = s1[t] * s1[t] + s2[t] * s2[t] - coefficient[t] * s1[t] * s2[t];
				s1[t] = s2[t] = 0.0;
				if (t > 0 && t <= LOWER_TONES)
					noise += power[t];
				else if (t > LOWER_TONES)
					upper += power[t] * refer[t];
			}
			noise /= LOWER_TONES;
			upper /= TONES - 1 - LOWER_TONES;
			if (blocks < MAX_BLOCKS && noise > 0.0 && upper > 0.0 && power[0] > 0.0) {
				pilots[blocks] = power[0];
				lowers[blocks] = noise;
				uppers[blocks++] = upper;
				lower_sum += noise;
				upper_sum += upper;
			}
		}
	}

	if (blocks == 0)
		return 0;
	/*
	 * A subsidiary carrier where the noise is read: read it above that carrier. Such a
	 * carrier is there all the time, so it is told from the whole look, not reading by
	 * reading: one reading of noise can sit that far above another by chance.
	 */
	out->upper = noise_from == NOISE_FOUND ? lower_sum > OCCUPIED * upper_sum : noise_from;
	for (k = 0; k < blocks; k++) {
		double noise = out->upper ? uppers[k] : lowers[k];

		quiets[k] = 10.0 * log10(usual_pilot / noise);
		readings[k] = 10.0 * log10(pilots[k] / noise);
	}
	out->pilot = ranked(readings, blocks, 0.5);
	out->low = ranked(readings, blocks, 0.0);
	out->offset = turned / (double)outputs * CHANNEL_RATE / (2.0 * PI);
	out->quiet = ranked(quiets, blocks, 0.5);
	out->swing = 0.0;
	if (programmes > 0) {
		double mean = programme / (double)programmes;
		double spread = programme_square / (double)programmes - mean * mean;

		out->swing = sqrt(spread > 0.0 ? spread : 0.0) * CHANNEL_RATE / (2.0 * PI) / 1000.0;
	}
	out->wide = 100.0 * (double)wide / (double)outputs;
	out->blocks = blocks;
	return 1;
}

/*
 * A further look at a channel, read as the first one was (first): through the narrower
 * filter for the second opinion on a faint pilot, or as it was taken in before.
 */
static int listen_as(const struct reading *first, int narrow, const uint8_t *iq, int pairs, double offset,
		     struct reading *out)
{
	int heard;

	filters();
	stage_2 = narrow ? taps_narrow : taps_2;
	noise_from = first->upper;
	heard = listen(iq, pairs, offset, out);
	stage_2 = taps_2;
	noise_from = NOISE_FOUND;
	return heard;
}

/* ---- a channel held against the one at its mirror place ---- */

/* The filters of listen() for one channel, fed a sample of the slice at a time */
struct chain {
	float ring_1r[2 * TAPS_1], ring_1i[2 * TAPS_1];
	float ring_2r[2 * TAPS_2], ring_2i[2 * TAPS_2];
	double rot_r, rot_i, step_r, step_i;
	int at_1, at_2, phase_1, phase_2;
};

static void chain_start(struct chain *chain, double offset)
{
	memset(chain, 0, sizeof(*chain));
	chain->rot_r = 1.0;
	chain->step_r = cos(-2.0 * PI * offset / SURVEY_RATE);
	chain->step_i = sin(-2.0 * PI * offset / SURVEY_RATE);
}

/* Returns 1 with the channel's next sample (240000 a second) when this one completes it */
static int chain_push(struct chain *chain, int n, double xr, double xi, float *out_r, float *out_i)
{
	double next;
	float yr = 0.0f, yi = 0.0f;
	int k;

	chain->ring_1r[chain->at_1] = chain->ring_1r[chain->at_1 + TAPS_1] = (float)(xr * chain->rot_r - xi * chain->rot_i);
	chain->ring_1i[chain->at_1] = chain->ring_1i[chain->at_1 + TAPS_1] = (float)(xr * chain->rot_i + xi * chain->rot_r);
	chain->at_1 = chain->at_1 + 1 == TAPS_1 ? 0 : chain->at_1 + 1;
	next = chain->rot_r * chain->step_r - chain->rot_i * chain->step_i;
	chain->rot_i = chain->rot_r * chain->step_i + chain->rot_i * chain->step_r;
	chain->rot_r = next;
	if ((n & 1023) == 0) {
		double size = sqrt(chain->rot_r * chain->rot_r + chain->rot_i * chain->rot_i);

		chain->rot_r /= size;
		chain->rot_i /= size;
	}
	if (++chain->phase_1 < 5)
		return 0;
	chain->phase_1 = 0;

	for (k = 0; k < TAPS_1; k++) {
		yr += taps_1[k] * chain->ring_1r[chain->at_1 + k];
		yi += taps_1[k] * chain->ring_1i[chain->at_1 + k];
	}
	chain->ring_2r[chain->at_2] = chain->ring_2r[chain->at_2 + TAPS_2] = yr;
	chain->ring_2i[chain->at_2] = chain->ring_2i[chain->at_2 + TAPS_2] = yi;
	chain->at_2 = chain->at_2 + 1 == TAPS_2 ? 0 : chain->at_2 + 1;
	if (++chain->phase_2 < 2)
		return 0;
	chain->phase_2 = 0;

	*out_r = *out_i = 0.0f;
	for (k = 0; k < TAPS_2; k++) {
		*out_r += taps_2[k] * chain->ring_2r[chain->at_2 + k];
		*out_i += taps_2[k] * chain->ring_2i[chain->at_2 + k];
	}
	return 1;
}

/*
 * How much of the channel at offset Hz is the channel at -offset turned over: 0 for two
 * signals that have nothing to do with each other, towards 1 for a channel that holds a
 * tuner's mirror of the other and little else. A signal s at +f whose mirror a s* lies
 * at -f: brought to the centre the two are s and a s*, and their product is a |s|^2,
 * which adds up; the product of two unrelated signals turns every way and does not.
 */
static double mirrored(const uint8_t *iq, int pairs, double offset)
{
	static struct chain here, there;
	double mean_i, mean_q;
	double sum_r = 0.0, sum_i = 0.0, power_here = 0.0, power_there = 0.0;
	int n;

	filters();
	chain_start(&here, offset);
	chain_start(&there, -offset);
	rest_level(iq, pairs, &mean_i, &mean_q);
	for (n = 0; n < pairs; n++) {
		double xr = iq[2 * n] - mean_i, xi = iq[2 * n + 1] - mean_q;
		float ar = 0.0f, ai = 0.0f, br = 0.0f, bi = 0.0f;
		int have = chain_push(&here, n, xr, xi, &ar, &ai);

		if (chain_push(&there, n, xr, xi, &br, &bi) && have) {
			sum_r += (double)ar * br - (double)ai * bi;
			sum_i += (double)ar * bi + (double)ai * br;
			power_here += (double)ar * ar + (double)ai * ai;
			power_there += (double)br * br + (double)bi * bi;
		}
	}
	if (power_here <= 0.0 || power_there <= 0.0)
		return 0.0;
	return sqrt(sum_r * sum_r + sum_i * sum_i) / sqrt(power_here * power_there);
}

/* ---- the channels of a slice ---- */

struct slice {
	double centre;		/* Hz */
	double rate;
	double channel[MAX_CHANNELS];	/* Hz, rising, one spacing apart */
	int count;
	int first, last;	/* the channels reported; the ones outside are neighbours only */
};

/* The spectrum channel_levels() last made: what tops() reads */
static double slice_psd[NFFT];

/* The power on each channel of the slice, within half Hz of its centre, in dB */
static int channel_levels(const struct slice *slice, const uint8_t *iq, int pairs,
			  double half, double *level)
{
	int c;

	if (!spectrum(iq, pairs, slice_psd))
		return 0;
	for (c = 0; c < slice->count; c++)
		level[c] = band_power(slice_psd, slice->rate, slice->channel[c] - slice->centre, half);
	return 1;
}

/*
 * Which channels of the slice channel_levels() has just looked at may hold a station of
 * their own: those that hold more, close to their centre, than the places 100 kHz
 * either side do (or the channels next to them, on a raster finer than that). A
 * station's power lies close to its carrier; what a stronger station spills into a
 * channel 200 kHz away is little there and much in the place between the two.
 */
static void tops(const struct slice *slice, int *top)
{
	double step = slice->count > 1 ? slice->channel[1] - slice->channel[0] : REACH;
	int c;

	if (step > REACH)
		step = REACH;
	for (c = 0; c < slice->count; c++) {
		double offset = slice->channel[c] - slice->centre;
		double own = band_power(slice_psd, slice->rate, offset, CORE_HALF);

		int n;

		top[c] = own + may_hold_more >= band_power(slice_psd, slice->rate, offset - step, CORE_HALF) &&
			 own + may_hold_more >= band_power(slice_psd, slice->rate, offset + step, CORE_HALF);
		for (n = 0; n < named_count && !top[c]; n++)
			top[c] = fabs(named[n] - slice->channel[c]) < 1000.0;
	}
}

/* Whether the channel holds more than both its neighbours */
static int is_top(const double *level, int count, int c)
{
	return c > 0 && c < count - 1 && level[c] >= level[c - 1] && level[c] >= level[c + 1];
}

/*
 * How unlike a slice looks at two gains, in dB: 0 when every signal in it differs by the
 * same amount. high and low are the channel levels at the two gains.
 *
 * What the gain did between the two is read from the signals themselves, never from
 * the names of the gain steps: the channels that stand clear of the noise at the low
 * gain are there at both, and the middle of their changes is the change of the gain.
 * (A tuner's steps are not what they are called. Measured on an E4000: the step named
 * 29 to 34 dB adds 0.1 dB, the one named 34 to 42 dB adds 6.3. Taken at their word,
 * every station seems to fall by 6 dB between two gains, and the slice to be
 * overloaded.) Against that change every channel is held that stands out at either
 * gain: a signal the tuner made is there at the high gain and not at the low one, and
 * departs. With no channel clear of the noise at the low gain there is nothing to hold
 * anything against, and nothing is said.
 *
 * One thing the names of the steps are still asked: a tuner driven far too hard holds
 * every station down alike, and nothing departs from anything. Where the stations rise
 * by HELD_DOWN less than the gain is named to have risen, that is what has happened: no
 * step measured so far is out by as much (the worst, on the E4000, by 8 dB over 20).
 */
static double departure(const double *high, const double *low, int count)
{
	double change[MAX_CHANNELS], sound[MAX_CHANNELS];
	double floor_low = ranked(low, count, 0.5);
	double reference, worst = 0.0;
	int used = 0, clear = 0;
	int c;

	for (c = 0; c < count; c++) {
		int at_low = is_top(low, count, c) && low[c] >= floor_low + JUDGED;

		if (at_low)
			sound[clear++] = high[c] - low[c];
		if (at_low || (is_top(high, count, c) && high[c] >= floor_low + JUDGED))
			change[used++] = high[c] - low[c];
	}
	if (clear == 0)
		return 0.0;
	reference = ranked(sound, clear, 0.5);
	for (c = 0; c < used; c++) {
		double away = fabs(change[c] - reference);

		if (away > worst)
			worst = away;
	}
	if (-reference >= HELD_DOWN && -reference > worst)
		worst = -reference;
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

/*
 * A dongle can open, tune and then deliver nothing: seen on a cheap one after a run
 * of starts, and it stayed so until it was unplugged. The library's read then waits
 * for ever. A read is given NO_SAMPLES_S seconds; after that the tool says what
 * happened, in a line and with a status of its own, and ends.
 */
#define NO_SAMPLES_S	5
#define EXIT_NO_SAMPLES	3

static void no_samples(int sig)
{
	static const char said[] = "fn-rtl-gain: the dongle delivers no samples\n";
	ssize_t written = write(2, said, sizeof said - 1);

	(void)sig;
	(void)written;
	_exit(EXIT_NO_SAMPLES);
}

static int read_samples(rtlsdr_dev_t *dev, uint8_t *into, int bytes, int *got)
{
	int result;

	alarm(NO_SAMPLES_S);
	result = rtlsdr_read_sync(dev, into, bytes, got);
	alarm(0);
	return result;
}

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
		if (read_samples(tuner->dev, into + done, want, &got) < 0 || got <= 0)
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
	read_samples(tuner->dev, tuner->block, tuner->block_bytes, &got);
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
	if (read_samples(tuner->dev, tuner->block, tuner->block_bytes, &got) < 0 ||
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

/* The highest step at least so far (tenths of a dB) below, or -1 when there is none */
static int step_below(const struct tuner *tuner, int index, int tenths)
{
	int lower;

	for (lower = index - 1; lower >= 0; lower--)
		if (tuner->gains[index] - tuner->gains[lower] >= tenths)
			return lower;
	return -1;
}

/*
 * The highest step, from index down, at which the slice looks as it does with a gain
 * far below. Returns the step to use.
 *
 * The gain far below is taken to be sound. Where the step found is that gain itself or
 * the one next to it, nothing says so: a very strong station can overload the tuner
 * there too. That gain is then tried in its turn against one further down, until a
 * step is found that stands clear of what it was compared with, or the steps run out.
 */
static int not_overloaded(struct tuner *tuner, const struct slice *slice, int index)
{
	double reference[MAX_CHANNELS], level[MAX_CHANNELS];
	int top = index;	/* the step under test */
	int found = -1;		/* a step that looked like a reference still in doubt */

	for (;;) {
		int far = step_below(tuner, top, REFERENCE_DOWN);
		int low, high;

		if (far < 0)
			far = 0;	/* the steps do not reach that far: the lowest */
		if (far == top || !levels_at(tuner, slice, far, reference) ||
		    !levels_at(tuner, slice, top, level))
			return found >= 0 ? found : top;
		if (departure(level, reference, slice->count) <= DEPARTURE)
			return found >= 0 ? found : top;

		/* overloaded at top: the highest step between that looks like far */
		low = far;
		high = top - 1;
		while (low < high) {
			int middle = (low + high + 1) / 2;

			if (levels_at(tuner, slice, middle, level) &&
			    departure(level, reference, slice->count) <= DEPARTURE)
				low = middle;
			else
				high = middle - 1;
		}
		if (low > far + 1 || far == 0)
			return low;
		found = low;
		top = far;
	}
}

/* The gain for one slice: not cut off, not overloaded. Returns the step or -1. */
static int settle(struct tuner *tuner, const struct slice *slice, int start,
		  double *share, double *level, int *backoff)
{
	int uncut = highest_uncut(tuner, start, share, level);
	int chosen;

	if (uncut < 0)
		return -1;
	chosen = not_overloaded(tuner, slice, uncut);
	*backoff = tuner->gains[uncut] - tuner->gains[chosen];
	if (chosen != uncut)
		measure(tuner, chosen, share, level);
	return chosen;
}

static int open_tuner(struct tuner *tuner, int device, uint32_t rate, int ppm, int piece_ms)
{
	memset(tuner, 0, sizeof(*tuner));
	signal(SIGALRM, no_samples);
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
static void around(struct slice *slice, double frequency, double centre, double rate)
{
	int k;

	slice->centre = centre;
	slice->rate = rate;
	slice->count = 0;
	for (k = -(MAX_CHANNELS / 2); k <= MAX_CHANNELS / 2 && slice->count < MAX_CHANNELS; k++) {
		double channel = frequency + k * 100000.0;

		if (fabs(channel - centre) <= rate / 2.0 - 150000.0)
			slice->channel[slice->count++] = channel;
	}
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
		/*
		 * Where the receiver will set the tuner for this station: a quarter of the
		 * sample rate above it, as rtl_fm does to keep the station off the tuning
		 * point. What reaches the converter there is what will reach it when the
		 * station plays.
		 */
		double centre = frequencies[at] + rate / 4.0;

		tune(&tuner, (uint32_t)centre);
		around(&slice, frequencies[at], centre, rate);
		chosen = settle(&tuner, &slice, index, &share, &level, &backoff);
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

/* What a slice's survey found on one channel */
struct found {
	double level;		/* its power, the gain taken off */
	int top;
	int heard;		/* demodulated: reading holds the pilot */
	struct reading reading;
	int narrowed;		/* a faint pilot, read through the narrower filter too: narrow */
	double narrow;
	int peaked;		/* the channel's own peak was measured: own */
	double own;
	int held;		/* measured again with the gain lower: again, and quiet and swing there */
	double again, againq, agains;
	int doubted;		/* may be the tuner's mirror of another channel */
	double mirror;		/* the share of it that is that channel turned over */
	int looked;		/* listened to with the tuner set elsewhere: moved, the least reading, quiet */
	double moved, least, movedq;
};

/*
 * Survey a slice from a piece of its signal: print the line that names the slice, begun
 * by the caller in heading, and measure its channels into found. again is the same slice
 * with the gain lower, or NULL when there is none. Returns 0 when there is nothing to
 * survey.
 */
/*
 * How far the power at a channel's centre stands above the higher of the places
 * OWN_SIDE either side of it, dB. Returns 0 where it cannot be told: one of the three
 * places lies on the tuner's own noise around the frequency it is set to, or outside
 * the slice.
 */
static int own_peak(const struct slice *slice, double offset, double *own)
{
	double lower, upper;
	int i;

	for (i = -1; i <= 1; i++) {
		double place = offset + i * OWN_SIDE;

		if (fabs(place) < OWN_HALF + ZERO_GUARD || fabs(place) + OWN_HALF > slice->rate / 2.0)
			return 0;
	}
	lower = band_power(slice_psd, slice->rate, offset - OWN_SIDE, OWN_HALF);
	upper = band_power(slice_psd, slice->rate, offset + OWN_SIDE, OWN_HALF);
	*own = band_power(slice_psd, slice->rate, offset, OWN_HALF) - (lower > upper ? lower : upper);
	return 1;
}

/* Listen to one channel of a slice, and take the further looks what is heard there asks for */
static void hear(const struct slice *slice, int c, const double *level, const uint8_t *iq, int pairs,
		 const uint8_t *again, int again_pairs, struct found *f)
{
	double offset = slice->channel[c] - slice->centre;
	struct reading held;
	int m;

	f->top = 1;
	if (!listen(iq, pairs, offset, &f->reading))
		return;
	f->heard = 1;
	/* nothing a station could be: no pilot, and no carrier clear of the noise */
	if (f->reading.pilot < PILOT_SEEN && f->reading.quiet < QUIET_SEEN)
		return;
	if (f->reading.pilot >= PILOT_SEEN && f->reading.pilot < PLAIN_PILOT &&
	    listen_as(&f->reading, 1, iq, pairs, offset, &held)) {
		f->narrowed = 1;
		f->narrow = held.pilot;
	}
	f->peaked = own_peak(slice, offset, &f->own);
	if (again != NULL && listen_as(&f->reading, 0, again, again_pairs, offset, &held)) {
		f->held = 1;
		f->again = held.pilot;
		f->againq = held.quiet;
		f->agains = held.swing;
	}
	/* the channel at the mirror place: is this one its copy? */
	if (fabs(offset) < slice->channel[1] - slice->channel[0])
		return;
	for (m = 0; m < slice->count; m++) {
		if (fabs(slice->channel[m] - slice->centre + offset) < 1.0)
			break;
	}
	if (m < slice->count && level[m] - level[c] >= MIRROR_STRONGER) {
		double share = mirrored(iq, pairs, offset);

		if (share >= MIRROR_SEEN) {
			f->doubted = 1;
			f->mirror = share;
		}
	}
}

static int examine(const struct slice *slice, const char *heading, const uint8_t *iq, int pairs,
		   double gain, const uint8_t *again, int again_pairs, struct found *found)
{
	double level[MAX_CHANNELS];
	int top[MAX_CHANNELS];
	int c, d;

	if (slice->first < 0 || !channel_levels(slice, iq, pairs, 75000.0, level))
		return 0;
	tops(slice, top);
	for (c = 0; c < slice->count; c++)
		level[c] -= gain;
	printf("%s floor=%.1f\n", heading,
	       ranked(level + slice->first, slice->last - slice->first + 1, 0.2));
	fflush(stdout);

	for (c = slice->first; c <= slice->last; c++) {
		memset(&found[c], 0, sizeof(found[c]));
		found[c].level = level[c];
		if (top[c])
			hear(slice, c, level, iq, pairs, again, again_pairs, &found[c]);
	}
	/*
	 * A faint pilot may be heard from the channel next to the station's own, which
	 * did not stand out: the channels within reach of it are listened to as well, so
	 * that the station is put where it shows best.
	 */
	for (c = slice->first; c <= slice->last; c++) {
		if (!top[c] || !found[c].heard || found[c].reading.pilot < PILOT_SEEN ||
		    found[c].reading.pilot >= PLAIN_PILOT)
			continue;
		for (d = slice->first; d <= slice->last; d++) {
			if (!found[d].top && fabs(slice->channel[d] - slice->channel[c]) < REACH + 1.0)
				hear(slice, d, level, iq, pairs, again, again_pairs, &found[d]);
		}
	}
	return 1;
}

/*
 * The second look at a channel that may be a mirror: a piece of signal with the tuner
 * set to centre, the channel frequency in it. Returns 1 with the channel's pilot there
 * and the least of its readings, or 0 when the look cannot tell: the channel lies at
 * another's mirror place here too.
 */
static int look(const uint8_t *iq, int pairs, double centre, double frequency, double *pilot, double *least,
		double *quiet)
{
	static double psd[NFFT];
	struct reading heard;
	double offset = frequency - centre;

	if (!spectrum(iq, pairs, psd))
		return 0;
	if (band_power(psd, SURVEY_RATE, -offset, 75000.0) - band_power(psd, SURVEY_RATE, offset, 75000.0) >= MIRROR_STRONGER &&
	    mirrored(iq, pairs, offset) >= MIRROR_SEEN)
		return 0;
	if (!listen(iq, pairs, offset, &heard))
		return 0;
	*pilot = heard.pilot;
	*least = heard.low;
	*quiet = heard.quiet;
	return 1;
}

/* The channels of a surveyed slice, a line each */
static void print_channels(const struct slice *slice, const struct found *found)
{
	int c;

	for (c = slice->first; c <= slice->last; c++) {
		const struct found *f = &found[c];

		printf("CHANNEL: freq=%.0f rf=%.1f top=%d", slice->channel[c], f->level, f->top);
		if (f->heard) {
			printf(" pilot=%.1f low=%.1f offset=%.0f quiet=%.1f swing=%.1f wide=%.2f", f->reading.pilot,
			       f->reading.low, f->reading.offset, f->reading.quiet, f->reading.swing, f->reading.wide);
			if (f->narrowed)
				printf(" narrow=%.1f", f->narrow);
			if (f->peaked)
				printf(" own=%.1f", f->own);
			if (f->held)
				printf(" again=%.1f againq=%.1f agains=%.1f", f->again, f->againq, f->agains);
			else
				printf(" again=-");
			if (f->doubted) {
				printf(" mirror=%.2f", f->mirror);
				if (f->looked)
					printf(" moved=%.1f least=%.1f movedq=%.1f", f->moved, f->least, f->movedq);
				else
					printf(" moved=-");
			}
		}
		printf("\n");
	}
	fflush(stdout);
}

static int survey(const struct band *band, int ppm, int device)
{
	static struct found found[MAX_CHANNELS];
	struct tuner tuner;
	struct slice slice;
	uint8_t *again;
	double centre;
	int again_bytes = (int)((uint64_t)SURVEY_RATE * 2 * AGAIN_MS / 1000);
	int failed = 0;
	int index, c;

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
		chosen = settle(&tuner, &slice, index, &share, &level, &backoff);
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
		lower = step_below(&tuner, chosen, AGAIN_DOWN);
		if (lower >= 0 && set_step(&tuner, lower) == 0)
			got_again = capture(&tuner, again, again_bytes);

		snprintf(heading, sizeof(heading),
			 "SLICE: freq=%.0f gain=%d.%d step=%d of=%d level=%.1f cut=%.2f backoff=%d.%d",
			 centre, tuner.gains[chosen] / 10, tuner.gains[chosen] % 10, chosen + 1,
			 tuner.steps, level, share * 100.0, backoff / 10, backoff % 10);
		if (!examine(&slice, heading, tuner.piece, got / 2, tuner.gains[chosen] / 10.0,
			     got_again >= again_bytes / 2 ? again : NULL, got_again / 2, found))
			continue;

		/*
		 * A channel that may be a mirror is listened to with the tuner set beside it,
		 * on one side and, if it lies at a mirror place there too, on the other. What
		 * the slice held is measured by now; the piece is free for it.
		 */
		for (c = slice.first; c <= slice.last; c++) {
			int side;

			for (side = 0; side < 2 && found[c].doubted && !found[c].looked; side++) {
				double beside = slice.channel[c] + (side == 0 ? MOVED_BY : -MOVED_BY);

				tune(&tuner, (uint32_t)beside);
				if (set_step(&tuner, chosen) < 0 ||
				    (got = capture(&tuner, tuner.piece, tuner.piece_bytes)) < tuner.piece_bytes / 2)
					break;
				found[c].looked = look(tuner.piece, got / 2, beside, slice.channel[c],
						       &found[c].moved, &found[c].least, &found[c].movedq);
			}
		}
		print_channels(&slice, found);
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
		       double centre, double gain, double lower_gain,
		       const char *moved_path, double moved_centre)
{
	static struct found found[MAX_CHANNELS];
	struct slice slice;
	char heading[200];
	uint8_t *iq, *again = NULL, *moved = NULL;
	long size = 0, again_size = 0, moved_size = 0;
	int c;

	/* as much as the survey listens to */
	iq = recorded(path, (long)((int64_t)SURVEY_RATE * 2 * LISTEN_MS / 1000), &size);
	if (iq == NULL)
		return 1;
	if (lower_path != NULL)
		again = recorded(lower_path, (long)((int64_t)SURVEY_RATE * 2 * AGAIN_MS / 1000), &again_size);
	if (moved_path != NULL)
		moved = recorded(moved_path, (long)((int64_t)SURVEY_RATE * 2 * LISTEN_MS / 1000), &moved_size);

	slice_channels(&slice, band, centre);
	if (slice.first < 0) {
		fprintf(stderr, "fn-rtl-gain: no channel of the band lies in a slice at %.0f Hz\n", centre);
		free(iq);
		free(again);
		free(moved);
		return 1;
	}
	snprintf(heading, sizeof(heading),
		 "SLICE: freq=%.0f gain=%.1f step=0 of=0 level=0.0 cut=0.00 backoff=0.0", centre, gain);
	if (examine(&slice, heading, iq, (int)(size / 2), gain, again, (int)(again_size / 2), found)) {
		/* the second look, at the channels the other recording reaches */
		for (c = slice.first; c <= slice.last; c++) {
			if (found[c].doubted && moved != NULL && fabs(slice.channel[c] - moved_centre) < SLICE_REACH)
				found[c].looked = look(moved, (int)(moved_size / 2), moved_centre, slice.channel[c],
						       &found[c].moved, &found[c].least, &found[c].movedq);
		}
		print_channels(&slice, found);
	}

	/* with the gain of the second recording known: how unlike the slice looks in the two */
	if (again != NULL && lower_gain >= 0.0) {
		double high[MAX_CHANNELS], low[MAX_CHANNELS];
		int brief = SURVEY_RATE * COMPARE_MS / 1000;
		int c;

		if (size / 2 >= brief && again_size / 2 >= brief &&
		    channel_levels(&slice, iq, brief, 100000.0, high) &&
		    channel_levels(&slice, again, brief, 100000.0, low)) {
			for (c = 0; c < slice.count; c++) {
				high[c] -= gain;
				low[c] -= lower_gain;
			}
			printf("COMPARE: gain=%.1f against=%.1f departure=%.1f\n",
			       gain, lower_gain, departure(high, low, slice.count));
		}
	}
	free(iq);
	free(again);
	free(moved);
	return 0;
}

/* ---- the measurements tried on a signal made up here ---- */

struct made {
	double offset;		/* Hz from the centre */
	double size;		/* converter counts */
	int pilot;		/* a stereo station */
	double mirror;		/* a tuner's mirror of it, as a share of its size */
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
			/* the mirror: the same turned over, on the other side of the centre */
			re += stations[s].mirror * stations[s].size * scale * cos(phase[s]);
			im -= stations[s].mirror * stations[s].size * scale * sin(phase[s]);
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
		{ 350000.0, 30.0, 1, 0.0 }, { -450000.0, 20.0, 0, 0.0 }, { -850000.0, 12.0, 1, 0.0 }
	};
	/* the first and the last of them, through a tuner that mirrors the first 24 dB down */
	static const struct made mirroring[] = {
		{ 350000.0, 30.0, 1, 0.063 }, { -850000.0, 12.0, 1, 0.0 }
	};
	static const struct band band = { 99500000.0, 101400000.0, 100000.0 };
	struct slice slice;
	struct reading stereo, plain, empty;
	double level[MAX_CHANNELS], high[MAX_CHANNELS], low[MAX_CHANNELS];
	int pairs = SURVEY_RATE * 4 / 10;
	int brief = SURVEY_RATE * COMPARE_MS / 1000;
	uint8_t *iq = malloc((size_t)pairs * 2);
	uint8_t *other = malloc((size_t)brief * 2);
	double alike, misnamed, unlike, copy, apart, seen = 0.0, seen_least = 0.0, seen_quiet = 0.0;
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
	/*
	 * The measures that need no pilot. The stereo station reads on them what its pilot
	 * reads; the one without a pilot (a mono station: a programme of 40 kHz swing) is as
	 * clear of the noise, swings as a broadcast does and never too far; the empty
	 * channel has no carrier clear of anything and swings every way.
	 */
	if (fabs(stereo.quiet - stereo.pilot) > 3.0 || plain.quiet < 40.0 || plain.swing < 20.0 || plain.swing > 35.0 ||
	    plain.wide > 0.5 || empty.quiet >= QUIET_SEEN || empty.wide < 5.0) {
		printf("selftest: without a pilot: stereo quiet %.1f against pilot %.1f; mono quiet %.1f swing %.1f wide %.2f; empty quiet %.1f wide %.2f\n",
		       stereo.quiet, stereo.pilot, plain.quiet, plain.swing, plain.wide, empty.quiet, empty.wide);
		failed = 1;
	}

	/* the same slice with every signal 6 dB down: treated alike */
	channel_levels(&slice, iq, brief, 100000.0, high);
	make_slice(other, brief, stations, 3, 0.5);
	channel_levels(&slice, other, brief, 100000.0, low);
	for (c = 0; c < slice.count; c++)
		low[c] += 6.0;
	alike = departure(high, low, slice.count);
	/* a gain step that is not what it is called (taken for 12.6 dB here) changes nothing */
	for (c = 0; c < slice.count; c++)
		low[c] += 6.6;
	misnamed = departure(high, low, slice.count);
	/* and with one of them gone, as a signal the tuner made is: not alike */
	make_slice(other, brief, stations, 2, 0.5);
	channel_levels(&slice, other, brief, 100000.0, low);
	for (c = 0; c < slice.count; c++)
		low[c] += 6.0;
	unlike = departure(high, low, slice.count);
	if (alike > DEPARTURE / 2.0 || misnamed > DEPARTURE / 2.0 || unlike <= DEPARTURE) {
		printf("selftest: overload check: %.1f dB for signals treated alike, %.1f dB with a gain step misnamed, %.1f dB for unlike\n",
		       alike, misnamed, unlike);
		failed = 1;
	}

	/*
	 * A tuner's mirror: the second stereo station is no copy of what lies across the
	 * centre from it; through a tuner that mirrors the first station, the empty channel
	 * across from that one is its copy, and a second look with the tuner elsewhere,
	 * where the channel is empty, finds no pilot.
	 */
	apart = mirrored(iq, pairs, -850000.0);
	make_slice(iq, pairs, mirroring, 2, 1.0);
	copy = mirrored(iq, pairs, -350000.0);
	make_slice(iq, pairs, stations, 3, 1.0);
	if (apart >= MIRROR_SEEN / 2.0 || copy < 2.0 * MIRROR_SEEN ||
	    !look(iq, pairs, 100450000.0, 100600000.0, &seen, &seen_least, &seen_quiet) || seen > 6.0 || seen_least > seen) {
		printf("selftest: mirror: %.2f for a station of its own, %.2f for a copy, pilot %.1f dB where there is none\n",
		       apart, copy, seen);
		failed = 1;
	}

	free(iq);
	free(other);
	if (failed)
		printf("selftest: failed\n");
	else
		printf("selftest: ok (pilot %.1f dB, none %.1f dB, alike %.1f dB, unlike %.1f dB, mirror %.2f, apart %.2f, mono %.1f dB swing %.1f kHz)\n",
		       stereo.pilot, plain.pilot, alike, unlike, copy, apart, plain.quiet, plain.swing);
	return failed;
}

int main(int argc, char **argv)
{
	uint32_t frequencies[MAX_FREQUENCIES];
	struct band band = { 0.0, 0.0, 0.0 };
	const char *recording = NULL;
	const char *recording_lower = NULL;
	const char *recording_moved = NULL;
	double centre = 0.0, recorded_gain = 0.0, recorded_lower = -1.0, moved_centre = 0.0;
	int count = 0;
	uint32_t rate = 1200000;
	int ppm = 0;
	int device = 0;
	int test = 0;
	int option;

	while ((option = getopt(argc, argv, "f:s:p:d:b:r:a:c:g:l:m:k:en:th")) != -1) {
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
		case 'l':
			recorded_lower = atof(optarg);
			break;
		case 'm':
			recording_moved = optarg;
			break;
		case 'k':
			moved_centre = scaled(optarg);
			break;
		case 'e':
			may_hold_more = CLEARLY_MORE;
			break;
		case 'n':
			if (named_count < MAX_NAMED)
				named[named_count++] = scaled(optarg);
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
			return centre > 0.0 && (recording_moved == NULL || moved_centre > 0.0) ?
				survey_file(&band, recording, recording_lower, centre, recorded_gain, recorded_lower,
					    recording_moved, moved_centre) : (usage(), 2);
		return survey(&band, ppm, device);
	}
	if (count == 0 || rate < 225001 || rate > 3200000) {
		usage();
		return 2;
	}
	return gains_for(frequencies, count, rate, ppm, device);
}
