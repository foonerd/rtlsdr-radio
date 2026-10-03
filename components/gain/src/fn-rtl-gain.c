/*
 * fn-rtl-gain: find the gain an RTL-SDR dongle should be set to at a frequency.
 *
 * A signal is received best when it fills the converter's range: with too little gain
 * it is lost in the rounding of an eight bit converter, with too much its peaks are cut
 * off and strong stations show up where there are none. The gain is therefore measured,
 * not guessed: the tuner's gain steps are walked, a few milliseconds of signal at each,
 * and the highest step is chosen at which next to none of the samples touch the ends of
 * the converter's range.
 *
 * The tuner's own automatic gain is not used: measured, it leaves a large share of the
 * samples cut off.
 *
 *   fn-rtl-gain -f <Hz> [-f <Hz> ...] [-s <samples per second>] [-p <ppm>] [-d <device>]
 *
 * One line is printed for each frequency:
 *   GAIN: freq=<Hz> gain=<dB> step=<n> of=<n> level=<mean of 127> cut=<percent>
 * and, when more than one frequency was given, the gain that suits them all:
 *   BAND: gain=<dB> step=<n> of=<n>
 * The exit status is 0 when every frequency was measured.
 *
 * This program is free software; you can redistribute it and/or modify it under the
 * terms of the GNU General Public License as published by the Free Software Foundation,
 * either version 2 of the License, or (at your option) any later version.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>

#include <rtl-sdr.h>

#define MAX_FREQUENCIES 64
#define MAX_GAINS       64

/* the share of samples at the ends of the converter's range that counts as too much */
#define TOO_MUCH        0.005

static void usage(void)
{
	fprintf(stderr,
		"usage: fn-rtl-gain -f <Hz> [-f <Hz> ...] [-s <samples per second>] [-p <ppm>] [-d <device>]\n");
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

/* Measure at one step: the share of samples at the ends of the range, and the mean level */
static int measure(rtlsdr_dev_t *dev, int gain, uint8_t *block, int length,
		   double *share, double *level)
{
	int got = 0;
	int ends = 0;
	double sum = 0.0;
	int i;

	if (rtlsdr_set_tuner_gain(dev, gain) < 0)
		return -1;
	usleep(20000);			/* the tuner settles */
	rtlsdr_reset_buffer(dev);
	/* the first block still holds samples of the step before */
	rtlsdr_read_sync(dev, block, length, &got);
	if (rtlsdr_read_sync(dev, block, length, &got) < 0 || got < length / 2)
		return -1;

	for (i = 0; i < got; i++) {
		if (block[i] == 0 || block[i] == 255)
			ends++;
		sum += block[i] > 127 ? block[i] - 127.5 : 127.5 - block[i];
	}
	*share = (double)ends / got;
	*level = sum / got;
	return 0;
}

int main(int argc, char **argv)
{
	uint32_t frequencies[MAX_FREQUENCIES];
	int gains[MAX_GAINS];
	int count = 0;
	int steps;
	uint32_t rate = 1200000;
	int ppm = 0;
	int device = 0;
	rtlsdr_dev_t *dev = NULL;
	uint8_t *block;
	int length;
	int option;
	int at;
	int index;
	int lowest = -1;
	int failed = 0;

	while ((option = getopt(argc, argv, "f:s:p:d:h")) != -1) {
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
		default:
			usage();
			return 2;
		}
	}
	if (count == 0 || rate < 225001 || rate > 3200000) {
		usage();
		return 2;
	}

	if (rtlsdr_open(&dev, (uint32_t)device) < 0 || dev == NULL) {
		fprintf(stderr, "fn-rtl-gain: cannot open device %d\n", device);
		return 1;
	}
	if (rtlsdr_set_sample_rate(dev, rate) < 0) {
		fprintf(stderr, "fn-rtl-gain: cannot set %u samples per second\n", rate);
		rtlsdr_close(dev);
		return 1;
	}
	if (ppm != 0)
		rtlsdr_set_freq_correction(dev, ppm);

	steps = rtlsdr_get_tuner_gains(dev, NULL);
	if (steps <= 0 || steps > MAX_GAINS) {
		fprintf(stderr, "fn-rtl-gain: the tuner names no gain steps\n");
		rtlsdr_close(dev);
		return 1;
	}
	steps = rtlsdr_get_tuner_gains(dev, gains);

	/* 16 ms of signal at a step, in the multiples of 512 bytes the library reads */
	length = (int)(((uint64_t)rate * 2 * 16 / 1000 + 511) / 512) * 512;
	block = malloc((size_t)length);
	if (block == NULL) {
		rtlsdr_close(dev);
		return 1;
	}

	/* the gain is set by this program, not by the tuner or the converter */
	rtlsdr_set_agc_mode(dev, 0);
	rtlsdr_set_tuner_gain_mode(dev, 1);

	index = steps * 4 / 5;
	if (index >= steps)
		index = steps - 1;

	for (at = 0; at < count; at++) {
		int chosen = -1;
		int direction = 0;
		double share = 0.0, level = 0.0;
		double chosen_share = 0.0, chosen_level = 0.0;
		int walk;

		/* with the gain as it suits a first tuning: an R828D needs it to lock */
		rtlsdr_set_tuner_gain_mode(dev, 0);
		rtlsdr_set_center_freq(dev, frequencies[at]);
		usleep(50000);
		rtlsdr_set_tuner_gain_mode(dev, 1);

		for (walk = 0; walk < steps; walk++) {
			if (measure(dev, gains[index], block, length, &share, &level) < 0)
				break;
			if (share > TOO_MUCH) {		/* peaks cut off: less gain */
				if (direction > 0)
					break;		/* the step before, already chosen, is the one */
				if (index == 0) {
					chosen = 0;
					chosen_share = share;
					chosen_level = level;
					break;
				}
				direction = -1;
				index--;
			} else {			/* room left: this step will do, a higher one may too */
				chosen = index;
				chosen_share = share;
				chosen_level = level;
				if (direction < 0 || index == steps - 1)
					break;
				direction = 1;
				index++;
			}
		}

		if (chosen < 0) {
			fprintf(stderr, "fn-rtl-gain: nothing could be read at %u Hz\n", frequencies[at]);
			failed = 1;
			continue;
		}
		printf("GAIN: freq=%u gain=%d.%d step=%d of=%d level=%.1f cut=%.2f\n",
		       frequencies[at], gains[chosen] / 10, gains[chosen] % 10,
		       chosen + 1, steps, chosen_level, chosen_share * 100.0);
		fflush(stdout);
		if (lowest < 0 || chosen < lowest)
			lowest = chosen;
		index = chosen;		/* the next frequency starts where this one ended */
	}

	if (count > 1 && lowest >= 0)
		printf("BAND: gain=%d.%d step=%d of=%d\n",
		       gains[lowest] / 10, gains[lowest] % 10, lowest + 1, steps);

	free(block);
	rtlsdr_close(dev);
	return failed;
}
