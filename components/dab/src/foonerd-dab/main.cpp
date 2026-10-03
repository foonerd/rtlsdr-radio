#
/*
 *    Copyright (C) 2015, 2016, 2017
 *    Jan van Katwijk (J.vanKatwijk@gmail.com)
 *    Lazy Chair Computing
 *
 *    This file is part of the DAB-library
 *
 *    DAB-library is free software; you can redistribute it and/or modify
 *    it under the terms of the GNU General Public License as published by
 *    the Free Software Foundation; either version 2 of the License, or
 *    (at your option) any later version.
 *
 *    DAB-library is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU General Public License for more details.
 *
 *    You should have received a copy of the GNU General Public License
 *    along with DAB-library; if not, write to the Free Software
 *    Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA
 *
 *	E X A M P L E  P R O G R A M
 *	for the DAB-library
 */
#include	<unistd.h>
#include	<signal.h>
#include	<getopt.h>
#include	<ctime>
#include        <cstdio>
#include	<fstream>
#include        <iostream>
#include	<complex>
#include	<vector>
#include	<atomic>
#include	"dab-api.h"
#include	"includes/support/band-handler.h"
#ifdef  HAVE_SDRPLAY
#include        "sdrplay-handler.h"
#elif  HAVE_SDRPLAY_V3
#include        "sdrplay-handler-v3.h"
#elif   HAVE_AIRSPY
#include        "airspy-handler.h"
#elif   HAVE_RTLSDR
#include        "rtlsdr-handler.h"
#elif   HAVE_WAVFILES
#include        "wavfiles.h"
#elif   HAVE_RAWFILES
#include        "rawfiles.h"
#elif   HAVE_RTL_TCP
#include        "rtl_tcp-client.h"
#elif   HAVE_HACKRF
#include        "hackrf-handler.h"
#elif   HAVE_LIME
#include        "lime-handler.h"
#endif

#include        <locale>
#include        <codecvt>
#include	<atomic>
#ifdef	DATA_STREAMER
#include	"tcp-server.h"
#endif

#ifdef	STREAMER_OUTPUT
#include	"streamer.h"
#endif
using std::cerr;
using std::endl;

// Runtime debug flag - controlled via -D command line option
bool debugEnabled = false;

std::string dirInfo;

void    printOptions (void);	// forward declaration
//	we deal with some callbacks, so we have some data that needs
//	to be accessed from global contexts
static
std::atomic<bool> run;

static
void	*theRadio	= nullptr;

#ifdef	STREAMER_OUTPUT
static
streamer	*theStreamer	= nullptr;
#endif

static
std::atomic<bool>timeSynced;

static
std::atomic<bool>timesyncSet;

static
std::atomic<bool>ensembleRecognized;

#ifdef	DATA_STREAMER
tcpServer	tdcServer (8888);
#endif

std::string	programName		= "Sky Radio";
int32_t		serviceIdentifier	= -1;

static void sighandler (int signum) {
        fprintf (stderr, "Signal caught, terminating!\n");
	run. store (false);
}

static
void	syncsignal_Handler (bool b, void *userData) {
	timeSynced. store (b);
	timesyncSet. store (true);
	(void)userData;
}
//
//	This function is called whenever the dab engine has taken
//	some time to gather information from the FIC bloks
//	the Boolean b tells whether or not an ensemble has been
//	recognized, the names of the programs are in the
//	ensemble
static
void	name_of_ensemble (const std::string &name, int Id, void *userData) {
	fprintf (stderr, "ensemble %s is (%X) recognized\n",
	                          name. c_str (), (uint32_t)Id);
	ensembleRecognized. store (true);
}
//
//      The function is called from the MOT handler, with
//      as parameters the filename where the picture is stored
//      d denotes the subtype of the picture
//      typedef void (*motdata_t)(std::string, int, void *);
static int motSequence = 0;

void    motdata_Handler (uint8_t * data, int size,
                         const char *name, int d, void *ctx) {
        (void)ctx;
        
        // Validate input
        if (data == NULL || size <= 0 || size > 10*1024*1024) {
                fprintf (stderr, "MOT: invalid data (size=%d)\n", size);
                return;
        }
        
        // Detect image type from magic bytes
        const char *ext = ".bin";
        const char *type = "unknown";
        if (size >= 2 && data[0] == 0xFF && data[1] == 0xD8) {
                ext = ".jpg";
                type = "JPEG";
        } else if (size >= 8 && data[0] == 0x89 && data[1] == 0x50 && 
                   data[2] == 0x4E && data[3] == 0x47) {
                ext = ".png";
                type = "PNG";
        }
        
        // Build filename: use provided name or generate sequence
        std::string slideName;
        if (name != NULL && strlen(name) > 0) {
                // Use provided filename (may already have extension)
                slideName = dirInfo + std::string(name);
        } else {
                // Generate with sequence number and detected extension
                char seqbuf[32];
                snprintf(seqbuf, sizeof(seqbuf), "slide_%04d%s", motSequence++, ext);
                slideName = dirInfo + std::string(seqbuf);
        }
        
        // Write image with validation
        FILE * temp = fopen (slideName. c_str (), "w+b");
        if (temp) {
                size_t written = fwrite (data, 1, size, temp);
                fclose (temp);
                
                if (written == (size_t)size) {
                        fprintf (stderr, "MOT: saved %s (%d bytes, %s, type=%d)\n", 
                                slideName.c_str(), size, type, d);
                        // Machine-readable format for v1.1.0 plugin
                        fprintf (stderr, "MOT_IMAGE: path=%s size=%d type=%s\n",
                                slideName.c_str(), size, type);
                } else {
                        fprintf (stderr, "MOT: write error %s (%zu/%d bytes)\n", 
                                slideName.c_str(), written, size);
                }
        } else {
                fprintf (stderr, "MOT: cannot open file %s\n", slideName. c_str());
        }
}

static
void	serviceName (const std::string &s, int SId, uint16_t subChId,
	                                              void * userdata) {
	fprintf (stderr, "%s (%X) is part of the ensemble\n", s. c_str (), SId);
}

static
void	programdata_Handler (audiodata *d, void *ctx) {
	(void)ctx;
	// Human-readable format (backward compatible)
	fprintf (stderr, "\tstartaddress\t= %d\n", d -> startAddr);
	fprintf (stderr, "\tlength\t\t= %d\n",     d -> length);
	fprintf (stderr, "\tsubChId\t\t= %d\n",    d -> subchId);
	fprintf (stderr, "\tprotection\t= %d\n",   d -> protLevel);
	fprintf (stderr, "\tbitrate\t\t= %d\n",    d -> bitRate);
	
	// Machine-readable format for v1.1.0 plugin parsing
	fprintf (stderr, "BITRATE: %d\n", d -> bitRate);
	fprintf (stderr, "DAB_TYPE: %s\n", (d -> ASCTy == 077) ? "DAB+" : "DAB");
}

//
//	The function is called from within the library with
//	a string, the so-called dynamic label
static std::string lastDlsLabel = "";

static
void	dataOut_Handler (const char *label, void *ctx) {
	(void)ctx;
	
	if (label == NULL) {
		return;
	}
	
	std::string strLabel = std::string(label);
	
	// Ignore very short labels (likely partial segments)
	if (strLabel.length() < 10) {
		return;
	}
	
	// Deduplicate - only process if changed
	// DAB sends DLS every 2-4 seconds even if unchanged
	if (strLabel == lastDlsLabel) {
		return;
	}
	
	// Ignore if new label is substring of previous (partial segment)
	if (lastDlsLabel.find(strLabel) != std::string::npos) {
		return;
	}
	
	// Ignore if previous label is substring of new (we already showed it)
	if (strLabel.find(lastDlsLabel) != std::string::npos && lastDlsLabel.length() > 20) {
		// But update stored label to the longer version
		lastDlsLabel = strLabel;
		return;
	}
	
	lastDlsLabel = strLabel;
	
	// Write with timestamp for plugin tracking
	std::string strLabelfile = dirInfo+"DABlabel.txt";
	std::ofstream out(strLabelfile, std::ios::trunc);
	if (out) {
		time_t now = time(NULL);
		out << "timestamp=" << now << "\n";
		out << "label=" << strLabel << "\n";
		out.close();
	} else {
		fprintf (stderr, "DLS: error writing to file %s\n", strLabelfile. c_str());
	}
	
	// Machine-readable format for v1.1.0 metadata
	fprintf (stderr, "DLS: %s\n", label);
}

//
//	DL Plus callback - receives semantic tags for dynamic label
//	Content types from ETSI TS 102 980:
//	1 = ITEM.TITLE, 4 = ITEM.ARTIST, 31 = STATIONNAME.LONG, etc.
static
void	dlPlusOut_Handler (const char *label, uint8_t numTags, 
                           dlPlusTag_t *tags, bool itemToggle, 
                           bool itemRunning, void *ctx) {
	(void)ctx;
	
	if (label == NULL || numTags == 0) {
		return;
	}
	
	std::string strLabel = std::string(label);
	
	// Write DL Plus data to file for plugin
	std::string dlPlusFile = dirInfo + "DABdlplus.txt";
	std::ofstream out(dlPlusFile, std::ios::trunc);
	if (out) {
		time_t now = time(NULL);
		out << "timestamp=" << now << "\n";
		out << "label=" << strLabel << "\n";
		out << "itemToggle=" << (itemToggle ? 1 : 0) << "\n";
		out << "itemRunning=" << (itemRunning ? 1 : 0) << "\n";
		out << "numTags=" << (int)numTags << "\n";
		
		// Output each tag
		for (int i = 0; i < numTags; i++) {
			out << "tag" << i << "=" 
			    << (int)tags[i].contentType << ","
			    << (int)tags[i].startMarker << ","
			    << (int)tags[i].length << "\n";
			
			// Extract tagged text from label
			int start = tags[i].startMarker;
			int len = tags[i].length + 1;  // length field is actual length - 1
			if (start >= 0 && start < (int)strLabel.length()) {
				std::string tagText = strLabel.substr(start, len);
				
				// Content type names for common types
				const char* typeName = "UNKNOWN";
				switch (tags[i].contentType) {
					case 0:  typeName = "DUMMY"; break;
					case 1:  typeName = "ITEM.TITLE"; break;
					case 2:  typeName = "ITEM.ALBUM"; break;
					case 3:  typeName = "ITEM.TRACKNUMBER"; break;
					case 4:  typeName = "ITEM.ARTIST"; break;
					case 5:  typeName = "ITEM.COMPOSITION"; break;
					case 6:  typeName = "ITEM.MOVEMENT"; break;
					case 7:  typeName = "ITEM.CONDUCTOR"; break;
					case 8:  typeName = "ITEM.COMPOSER"; break;
					case 9:  typeName = "ITEM.BAND"; break;
					case 10: typeName = "ITEM.COMMENT"; break;
					case 11: typeName = "ITEM.GENRE"; break;
					case 12: typeName = "INFO.NEWS"; break;
					case 13: typeName = "INFO.NEWS.LOCAL"; break;
					case 14: typeName = "INFO.STOCKMARKET"; break;
					case 15: typeName = "INFO.SPORT"; break;
					case 16: typeName = "INFO.LOTTERY"; break;
					case 17: typeName = "INFO.HOROSCOPE"; break;
					case 18: typeName = "INFO.DAILY_DIVERSION"; break;
					case 19: typeName = "INFO.HEALTH"; break;
					case 20: typeName = "INFO.EVENT"; break;
					case 21: typeName = "INFO.SCENE"; break;
					case 22: typeName = "INFO.CINEMA"; break;
					case 23: typeName = "INFO.TV"; break;
					case 24: typeName = "INFO.DATE_TIME"; break;
					case 25: typeName = "INFO.WEATHER"; break;
					case 26: typeName = "INFO.TRAFFIC"; break;
					case 27: typeName = "INFO.ALARM"; break;
					case 28: typeName = "INFO.ADVERTISEMENT"; break;
					case 29: typeName = "INFO.URL"; break;
					case 30: typeName = "INFO.OTHER"; break;
					case 31: typeName = "STATIONNAME.SHORT"; break;
					case 32: typeName = "STATIONNAME.LONG"; break;
					case 33: typeName = "PROGRAMME.NOW"; break;
					case 34: typeName = "PROGRAMME.NEXT"; break;
					case 35: typeName = "PROGRAMME.PART"; break;
					case 36: typeName = "PROGRAMME.HOST"; break;
					case 37: typeName = "PROGRAMME.EDITORIAL_STAFF"; break;
					case 38: typeName = "PROGRAMME.FREQUENCY"; break;
					case 39: typeName = "PROGRAMME.HOMEPAGE"; break;
					case 40: typeName = "PROGRAMME.SUBCHANNEL"; break;
					case 41: typeName = "PHONE.HOTLINE"; break;
					case 42: typeName = "PHONE.STUDIO"; break;
					case 43: typeName = "PHONE.OTHER"; break;
					case 44: typeName = "SMS.STUDIO"; break;
					case 45: typeName = "SMS.OTHER"; break;
					case 46: typeName = "EMAIL.HOTLINE"; break;
					case 47: typeName = "EMAIL.STUDIO"; break;
					case 48: typeName = "EMAIL.OTHER"; break;
					case 49: typeName = "MMS.OTHER"; break;
					case 50: typeName = "CHAT"; break;
					case 51: typeName = "CHAT.CENTRE"; break;
					case 52: typeName = "VOTE.QUESTION"; break;
					case 53: typeName = "VOTE.CENTRE"; break;
					case 59: typeName = "DESCRIPTOR.PLACE"; break;
					case 60: typeName = "DESCRIPTOR.APPOINTMENT"; break;
					case 61: typeName = "DESCRIPTOR.IDENTIFIER"; break;
					case 62: typeName = "DESCRIPTOR.PURCHASE"; break;
					case 63: typeName = "DESCRIPTOR.GET_DATA"; break;
				}
				out << typeName << "=" << tagText << "\n";
			}
		}
		out.close();
		
		// Machine-readable stderr output
		fprintf(stderr, "DL+: %d tags, running=%d\n", numTags, itemRunning ? 1 : 0);
		for (int i = 0; i < numTags; i++) {
			if (tags[i].startMarker < strLabel.length()) {
				int len = tags[i].length + 1;
				std::string tagText = strLabel.substr(tags[i].startMarker, len);
				fprintf(stderr, "DL+ TAG[%d]: type=%d start=%d len=%d text=\"%s\"\n",
				        i, tags[i].contentType, tags[i].startMarker, 
				        tags[i].length, tagText.c_str());
			}
		}
	} else {
		fprintf(stderr, "DL+: error writing to %s\n", dlPlusFile.c_str());
	}
}
//
//	Note: the function is called from the tdcHandler with a
//	frame, either frame 0 or frame 1.
//	The frames are packed bytes, here an additional header
//	is added, a header of 8 bytes:
//	the first 4 bytes for a pattern 0xFF 0x00 0xFF 0x00 0xFF
//	the length of the contents, i.e. framelength without header
//	is stored in bytes 5 (high byte) and byte 6.
//	byte 7 contains 0x00, byte 8 contains 0x00 for frametype 0
//	and 0xFF for frametype 1
//	Note that the callback function is executed in the thread
//	that executes the tdcHandler code.
static
void	bytesOut_Handler (uint8_t *data, int16_t amount,
	                  uint8_t type, void *ctx) {
#ifdef DATA_STREAMER
uint8_t localBuf [amount + 8];
int16_t i;
	localBuf [0] = 0xFF;
	localBuf [1] = 0x00;
	localBuf [2] = 0xFF;
	localBuf [3] = 0x00;
	localBuf [4] = (amount >> 8) & 0xFF;
	localBuf [5] = amount & 0xFF;
	localBuf [6] = 0x00;
	localBuf [7] = type == 0 ? 0 : 0xFF;
	for (i = 0; i < amount; i ++)
	   localBuf [8 + i] = data;
	tdcServer. sendData (localBuf, amount + 8);
#else
	(void)data;
	(void)amount;
#endif
	(void)ctx;
}

void    tii_data_Handler        (tiiData *theData, void *x) {
	(void)theData;
	(void)x;
}


void    timeHandler             (int hours, int minutes, void *ctx) {
//      fprintf (stderr, "%2d:%2d\n", hours, minutes);
        (void)ctx;
}

//
//
//	In this example the PCM samples are written out to stdout.
//	In order to fill "gaps" in the output, the output is send
//	through a simple task, monitoring the amount of samples
//	passing by and sending additional 0 samples in case
//	of gaps
//
static bool pcmFormatReported = false;
static int lastRate = 0;
static bool lastStereo = false;

static
void	pcmHandler (int16_t *buffer, int size, int rate,
	                              bool isStereo, void *ctx) {
	// Report PCM format on first call AND when format changes
	// DAB streams can switch rates (rare but possible)
	if (!pcmFormatReported || rate != lastRate || isStereo != lastStereo) {
		fprintf(stderr, "PCM: rate=%d stereo=%d size=%d\n", 
		        rate, isStereo ? 1 : 0, size);
		fprintf(stderr, "AUDIO_FORMAT: rate=%d channels=%d\n",
		        rate, isStereo ? 2 : 1);
		pcmFormatReported = true;
		lastRate = rate;
		lastStereo = isStereo;
	}
	
	// Validate buffer before write
	// Note: size=0 on first call is normal (format detection)
	if (buffer == NULL || size <= 0) {
		return;
	}
	
#ifdef	STREAMER_OUTPUT
	if (theStreamer == NULL)
	   return;
	if (theStreamer -> isRunning ())
	   theStreamer -> addBuffer (buffer, size, 2);
#else
	// Write with error handling and immediate flush
	size_t written = fwrite ((void *)buffer, size, 2, stdout);
	if (written != 2) {
		fprintf(stderr, "PCM: write error (expected 2, wrote %zu)\n", written);
	}
	fflush(stdout); // Ensure immediate delivery to pipeline
#endif
}

// Signal quality tracking - static variables for callback data
static int16_t currentSnr = 0;
static bool currentSync = false;
static int16_t currentFibQuality = 0;
static int16_t currentFrameErrors = 0;
static int16_t currentRsErrors = 0;
static int16_t currentAacOk = 0;
static time_t lastSignalWrite = 0;

static
void	systemData (bool flag, int16_t snr, int32_t freqOff, void *ctx) {
	currentSync = flag;
	currentSnr = snr;
	if (debugEnabled) {
		fprintf(stderr, "SYSTEM: sync=%s snr=%d freqOff=%d\n",
		        flag ? "on" : "off", snr, freqOff);
	}
}

static
void	fibQuality	(int16_t q, void *ctx) {
	currentFibQuality = q;
	if (debugEnabled) {
		fprintf(stderr, "FIB_QUALITY: %d\n", q);
	}
}

static
void	mscQuality	(int16_t fe, int16_t rsE, int16_t aacE, void *ctx) {
	currentFrameErrors = fe;
	currentRsErrors = rsE;
	currentAacOk = aacE;
	
	if (debugEnabled) {
		fprintf(stderr, "MSC_QUALITY: fe=%d rs=%d aac=%d\n", fe, rsE, aacE);
	}
	
	// Write signal file every 2 seconds if output directory specified
	time_t now = time(NULL);
	if (now - lastSignalWrite >= 2 && dirInfo.length() > 0) {
		lastSignalWrite = now;
		
		// Calculate signal level (0-5) based on FIB quality and AAC decode success
		int signalLevel = 0;
		int signalPercent = 0;
		
		if (currentFibQuality >= 98 && currentAacOk >= 98) {
			signalLevel = 5;
			signalPercent = 95 + (currentFibQuality + currentAacOk) / 40;
		} else if (currentFibQuality >= 95 && currentAacOk >= 95) {
			signalLevel = 4;
			signalPercent = 80 + (currentFibQuality + currentAacOk - 190) / 2;
		} else if (currentFibQuality >= 85 && currentAacOk >= 85) {
			signalLevel = 3;
			signalPercent = 60 + (currentFibQuality + currentAacOk - 170) / 2;
		} else if (currentFibQuality >= 70 && currentAacOk >= 70) {
			signalLevel = 2;
			signalPercent = 40 + (currentFibQuality + currentAacOk - 140) / 2;
		} else if (currentFibQuality >= 50) {
			signalLevel = 1;
			signalPercent = 20 + (currentFibQuality - 50) / 2;
		} else {
			signalLevel = 0;
			signalPercent = currentFibQuality / 3;
		}
		
		if (signalPercent > 100) signalPercent = 100;
		if (signalPercent < 0) signalPercent = 0;
		
		// Write signal file
		std::string signalFile = dirInfo + "DABsignal.txt";
		std::ofstream out(signalFile, std::ios::trunc);
		if (out) {
			out << "timestamp=" << now << "\n";
			out << "sync=" << (currentSync ? "1" : "0") << "\n";
			out << "snr=" << currentSnr << "\n";
			out << "fib_quality=" << currentFibQuality << "\n";
			out << "frame_errors=" << currentFrameErrors << "\n";
			out << "rs_corrections=" << currentRsErrors << "\n";
			out << "audio_ok=" << currentAacOk << "\n";
			out << "signal_level=" << signalLevel << "\n";
			out << "signal_percent=" << signalPercent << "\n";
			out.close();
		}
		
		// Machine-readable stderr for plugin parsing
		fprintf(stderr, "DAB_SIGNAL: level=%d percent=%d fib=%d aac=%d\n",
		        signalLevel, signalPercent, currentFibQuality, currentAacOk);
	}
}


int	main (int argc, char **argv) {
// Default values
uint8_t		theMode		= 1;
std::string	theChannel	= "11C";
uint8_t		theBand		= BAND_III;
bool		wantInfo	= false;
#ifdef	HAVE_HACKRF
int		lnaGain		= 40;
int		vgaGain		= 40;
int		ppmOffset	= 0;
const char	*optionsString	= "i:T:D:d:M:B:P:O:A:C:G:g:p:";
#elif	HAVE_LIME
int16_t		gain		= 70;
std::string	antenna		= "Auto";
const char	*optionsString	= "i:T:D:d:M:B:P:O:A:C:G:g:X:";
#elif	HAVE_SDRPLAY
int16_t		GRdB		= 30;
int16_t		lnaState	= 2;
bool		autogain	= false;
int16_t		ppmOffset	= 0;
const char	*optionsString	= "i:T:D:d:M:B:P:O:A:C:G:L:Qp:";
#elif	HAVE_SDRPLAY_V3
int16_t		GRdB		= 30;
int16_t		lnaState	= 2;
bool		autogain	= false;
int16_t		ppmOffset	= 0;
const char	*optionsString	= "i:T:D:d:M:B:P:O:A:C:G:L:Qp:";
#elif	HAVE_AIRSPY
int16_t		gain		= 20;
bool		autogain	= false;
int		ppmOffset	= 0;
const char	*optionsString	= "i:T:D:d:M:B:P:O:A:C:G:p:S:";
#elif	HAVE_RTLSDR
int16_t		gain		= 50;
bool		autogain	= false;
int16_t		ppmOffset	= 0;
const char	*optionsString	= "i:T:D:d:M:B:P:O:A:C:G:p:QS:v";
#elif	HAVE_WAVFILES
std::string	fileName;
bool		repeater	= true;
const char	*optionsString	= "i:D:d:M:B:P:O:A:F:R:";
#elif	HAVE_RAWFILES
std::string	fileName;
bool	repeater		= true;
const char	*optionsString	= "i:D:d:M:B:P:O:A:F:R:";
#elif	HAVE_RTL_TCP
int		gain		= 50;
bool		autogain	= false;
int		ppmOffset	= 0;
std::string	hostname = "127.0.0.1";		// default
int32_t		basePort = 1234;		// default
const char	*optionsString	= "i:T:D:d:M:B:P:O:A:C:G:Qp:H:I";
#endif
std::string	soundChannel	= "default";
int16_t		timeSyncTime	= 5;
int16_t		freqSyncTime	= 5;
int		theDuration	= -1;	// default, infinite
int		opt;
struct sigaction sigact;
bandHandler	dabBand;
deviceHandler	*theDevice;

	// Based on dab-cmdline by J van Katwijk (Lazy Chair Computing)
	timeSynced.	store (false);
	timesyncSet.	store (false);
	run.		store (false);

	std::setlocale (LC_ALL, "");
	if (argc == 1) {
	   printOptions ();
	   exit (1);
	}

	while ((opt = getopt (argc, argv, optionsString)) != -1) {
	   switch (opt) {
	      case 'i':
	         wantInfo = true;
	         dirInfo = std::string (optarg);
	         dirInfo += "/";
	         break;

	      case 'T':
	         theDuration	= 60 * atoi (optarg);
	         break;

	      case 'D':
	         freqSyncTime	= atoi (optarg);
	         break;

	      case 'd':
	         timeSyncTime	= atoi (optarg);
	         break;

	      case 'M':
	         theMode	= atoi (optarg);
	         if (!((theMode == 1) || (theMode == 2) || (theMode == 4)))
	            theMode = 1;
	         break;

	      case 'B':
	         theBand = std::string (optarg) == std::string ("L_BAND") ?
	                                                 L_BAND : BAND_III;
	         break;

	      case 'P':
	         programName	= optarg;
	         break;

#ifdef	HAVE_WAVFILES
	      case 'F':
	         fileName	= std::string (optarg);

	      case 'R':
	         repeater	= false;
	         break;
#elif	HAVE_RAWFILES
	      case 'F':
	         fileName	= std::string (optarg);
	         break;

	      case 'R':	         repeater	= false;
	         break;

#elif	HAVE_HACKRF
	      case 'G':
	         lnaGain	= atoi (optarg);
	         break;

	      case 'g':
	         vgaGain	= atoi (optarg);
	         break;

	      case 'C':
	         theChannel	= std::string (optarg);
	         break;

	      case 'p':
	         ppmOffset	= 0;
	         break;

#elif	HAVE_LIME
	      case 'G':
	      case 'g':
	         gain		= atoi (optarg);
	         break;

	      case 'X':
	         antenna	= std::string (optarg);
	         break;

	      case 'C':
	         theChannel	= std::string (optarg);
	         fprintf (stderr, "%s \n", optarg);
	         break;

#elif	HAVE_SDRPLAY
	      case 'G':
	         GRdB		= atoi (optarg);
	         break;

	      case 'L':
	         lnaState	= atoi (optarg);
	         break;

	      case 'Q':
	         autogain	= true;
	         break;

	      case 'C':
	         theChannel	= std::string (optarg);
	         break;

	      case 'p':
	         ppmOffset	= atoi (optarg);
	         break;

#elif	HAVE_AIRSPY
	      case 'G':
	         gain		= atoi (optarg);
	         break;

	      case 'Q':
	         autogain	= true;
	         break;

	      case 'p':
	         ppmOffset	= atoi (optarg);
	         break;

	      case 'C':
	         theChannel	= std::string (optarg);
	         break;

#elif	HAVE_RTLSDR
	      case 'G':
	         gain		= atoi (optarg);
	         break;

	      case 'Q':
	         autogain	= true;
	         break;

	      case 'p':
	         ppmOffset	= atoi (optarg);
	         break;

	      case 'C':
	         theChannel	= std::string (optarg);
	         break;

	      case 'v':
	         debugEnabled	= true;
	         break;

#elif	HAVE_RTL_TCP
	      case 'C':
	         theChannel	= std::string (optarg);
	         break;

	      case 'H':
	         hostname	= std::string (optarg);
	         break;

	      case 'I':
	         basePort	= atoi (optarg);
	         break;
	      case 'G':
	         gain		= atoi (optarg);
	         break;

	      case 'Q':
	         autogain	= true;
	         break;

	      case 'p':
	         ppmOffset	= atoi (optarg);
	         break;

#endif

	      case 'S': {
                 std::stringstream ss;
                 ss << std::hex << optarg;
                 ss >> serviceIdentifier;
                 break;
              }

	      default:
	         fprintf (stderr, "Option %c ??\n", opt);
	         printOptions ();
	         exit (1);
	   }
	}
//
	sigact.sa_handler = sighandler;
	sigemptyset(&sigact.sa_mask);
	sigact.sa_flags = 0;

	int32_t frequency	= dabBand. Frequency (theBand, theChannel);
	try {
#ifdef	HAVE_SDRPLAY
	   theDevice	= new sdrplayHandler (frequency,
	                                      ppmOffset,
	                                      GRdB,
	                                      lnaState,
	                                      autogain,
	                                      0,
	                                      0);
#elif	HAVE_SDRPLAY_V3
	   theDevice	= new sdrplayHandler_v3 (frequency,
	                                      ppmOffset,
	                                      GRdB,
	                                      lnaState,
	                                      autogain,
	                                      0,
	                                      0);
#elif	HAVE_AIRSPY
	   theDevice	= new airspyHandler (frequency,
	                                     ppmOffset,
	                                     gain, false);
#elif	HAVE_RTLSDR
	   theDevice	= new rtlsdrHandler (frequency,
	                                     ppmOffset,
	                                     gain,
	                                     autogain);
#elif   HAVE_HACKRF
           theDevice    = new hackrfHandler     (frequency,
                                                 ppmOffset,
                                                 lnaGain,
                                                 vgaGain);
#elif   HAVE_LIME
           theDevice    = new limeHandler       (frequency, gain, antenna);
#elif	HAVE_WAVFILES
	   theDevice	= new wavFiles (fileName, repeater);
#elif	HAVE_RAWFILES
	   theDevice	= new rawFiles (fileName, repeater);
#elif	HAVE_RTL_TCP
	   theDevice	= new rtl_tcp_client (hostname,
	                                      basePort,
	                                      frequency,
	                                      gain,
	                                      autogain,
	                                      ppmOffset);
#endif
	}
	catch (std::exception& ex) {
	   fprintf (stderr, "Exception : %s\n",ex.what());
	   exit (1);
	}
#ifdef	STREAMER_OUTPUT
	theStreamer	= new streamer ();
#endif
//
//	and with a sound device we now can create a "backend"
	API_struct interface;
	interface. dabMode	= theMode;
	interface. thresholdValue	= 6;
	interface. syncsignal_Handler	= syncsignal_Handler;
	interface. systemdata_Handler	= systemData;
	interface. name_of_ensemble	= name_of_ensemble;
	interface. serviceName		= serviceName;
	interface. fib_quality_Handler	= fibQuality;
	interface. audioOut_Handler	= pcmHandler;
	interface. dataOut_Handler	= wantInfo == true ? dataOut_Handler : nullptr;
	interface. dlPlusOut_Handler	= wantInfo == true ? dlPlusOut_Handler : nullptr;
	interface. bytesOut_Handler	= bytesOut_Handler;
	interface. programdata_Handler	= programdata_Handler;
	interface. program_quality_Handler		= mscQuality;
	interface. motdata_Handler	= wantInfo == true ? motdata_Handler : nullptr;
	interface. tii_data_Handler	= tii_data_Handler;
	interface. timeHandler		= timeHandler;

//	and with a sound device we can create a "backend"
	theRadio	= (void *)dabInit (theDevice,
	                                   &interface,
	                                   NULL,	// no spectrum shown
	                                   NULL,	// no constellations
	                                   NULL		//ctx
	                               );
	if (theRadio == NULL) {
	   fprintf (stderr, "sorry, no radio device available, fatal\n");
	   exit (4);
	}

	theDevice	-> restartReader (frequency);
//
//	The device should be working right now

	timesyncSet.		store (false);
	ensembleRecognized.	store (false);
	dabStartProcessing (theRadio);

	while (!timeSynced. load () && (--timeSyncTime >= 0))
           sleep (1);

        if (!timeSynced. load ()) {
           cerr << "There does not seem to be a DAB signal here" << endl;
	   theDevice -> stopReader ();
           sleep (1);
           dabStop	(theRadio);
	   dabExit	(theRadio);
           delete theDevice;
           exit (22);
	}
        else
	   fprintf (stderr, "there might be a DAB signal here\n");

	if (!ensembleRecognized. load ())
	while (!ensembleRecognized. load () &&
                                     (--freqSyncTime >= 0)) {
	   fprintf (stderr, "Sleeping 1\n");
//           std::cerr << freqSyncTime + 1 << std::endl;
           sleep (1);
        }
	fprintf (stderr, "\n");;

	if (!ensembleRecognized. load ()) {
	   fprintf (stderr, "no ensemble data found, fatal\n");
	   theDevice -> stopReader ();
	   sleep (1);
	   dabStop	(theRadio);
	   dabExit	(theRadio);
	   delete theDevice;
	   exit (22);
	}

	sleep (3);
	run. store (true);
	if (serviceIdentifier != -1) {
	   char temp [255];
	   programName = dab_getserviceName (theRadio, serviceIdentifier);
	}

	fprintf (stderr,"we try to start program %s\n", programName.c_str());
	if (!is_audioService (theRadio, programName)) {
	   std::cerr << "sorry  we cannot handle service " <<
                                                 programName << "\n";
	   run. store (false);
	}
	else {
	   audiodata ad;
	   dataforAudioService (theRadio, programName, ad, 0);
	   if (ad. defined) {
	      dabReset_msc (theRadio);
	      set_audioChannel (theRadio, ad);
	   }
	   else {
	      std::cerr << "sorry  we cannot handle service " <<
                                                 programName << "\n";
	      run. store (false);
	   }
	}

	while (run. load () && (theDuration != 0)) {
	   if (theDuration > 0)
	      theDuration --;
	   sleep (1);
	}
	theDevice	-> stopReader ();
	dabStop (theRadio);
	dabExit	(theRadio);
	delete theDevice;
}

void    printOptions (void) {
        std::cerr <<
"                          dab-cmdline options are\n"
"	                  -i path\tsave dynamic label and MOT slide to <path>\n"
"	                  -T duration\thalt after <duration>  minutes\n"
"	                  -M Mode\tMode is 1, 2 or 4. Default is Mode 1\n"
"	                  -D number\tamount of time to look for an ensemble\n"
"	                  -d number\tseconds to reach time sync\n"
"	                  -P name\tprogram to be selected in the ensemble\n"
"	for file input:\n"
"	                  -F filename\tin case the input is from file\n"
"	                  -R switch off automatic continuation after eof\n"
"	for hackrf:\n"
"	                  -B Band\tBand is either L_BAND or BAND_III (default)\n"
"	                  -C Channel\n"
"	                  -v vgaGain\n"
"	                  -l lnaGain\n"
"	                  -a amp enable (default off)\n"
"	                  -c number\tppm offset\n"
"	for SDRplay:\n"
"	                  -B Band\tBand is either L_BAND or BAND_III (default)\n"
"	                  -C Channel\n"
"	                  -G Gain reduction in dB (range 20 .. 59)\n"
"	                  -L lnaState (depends on model chosen)\n"
"	                  -Q autogain (default off)\n"
"	                  -c number\t ppm offset\n"
"	for rtlsdr:\n"
"	                  -B Band\tBand is either L_BAND or BAND_III (default)\n"
"	                  -C Channel\n"
"	                  -G number\t	gain, range 0 .. 100\n"
"	                  -Q autogain (default off)\n"
"	                  -c number\tppm offset\n"
"	                  -v verbose debug output\n"
"	for airspy:\n"
"	                  -B Band\tBand is either L_BAND or BAND_III (default)\n"
"	                  -C Channel\n"
"	                  -G number\t	gain, range 1 .. 21\n"
"	                  -b set rf bias\n"
"	                  -c number\t ppm Correction\n"
"	for rtl_tcp:\n"
"	                  -H url\t hostname for connection\n"
"	                  -I number\t baseport for connection\n"
"	                  -G number\t gain setting\n"
"	                  -Q autogain (default off)\n"
"	                  -c number\t ppm Correction\n"
"      for limesdr:\n"
"                         -G number\t gain\n"
"                         -X antenna selection\n"
"                         -C channel\n";
}
