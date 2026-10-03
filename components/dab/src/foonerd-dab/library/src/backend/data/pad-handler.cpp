#
/*
 *    Copyright (C) 2015 .. 2017
 *    Jan van Katwijk (J.vanKatwijk@gmail.com)
 *    Lazy Chair Computing
 *
 *    This file is part of the DAB library
 *    DAB library is free software; you can redistribute it and/or modify
 *    it under the terms of the GNU General Public License as published by
 *    the Free Software Foundation; either version 2 of the License, or
 *    (at your option) any later version.
 *
 *    DAB library is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU General Public License for more details.
 *
 *    You should have received a copy of the GNU General Public License
 *    along with DAB library; if not, write to the Free Software
 *    Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA  02111-1307  USA
 */
#include	"pad-handler.h"
#include	<cstring>
#include	"charsets.h"
#include	"mot-object.h"
/**
  *	\class padHandler
  *	Handles the pad segments passed on from mp2- and mp4Processor
  */
	padHandler::padHandler	(API_struct *p, void *ctx) {
	this	-> dataOut		= p -> dataOut_Handler;
	this	-> dlPlusOut		= p -> dlPlusOut_Handler;
	this	-> motdata_Handler	= p -> motdata_Handler;
	this	-> ctx			= ctx;
//
//	mscGroupElement indicates whether we are handling an
//	msc datagroup or not.
	mscGroupElement	= false;
	dataGroupLength	= 0;

//	xpadLength tells - if mscGroupElement is "on" - the size of the
//	xpadfields, needed for handling xpads without CI's
	xpadLength	= -1;
	still_to_go	= 0;
	lastSegment	= false;
	firstSegment	= false;
	segmentNumber	= -1;
	currentSlide	= nullptr;
	dynamicLabelText. clear ();
	resetLabel (-1);
	dlPlusToggle	= -1;
	shortPadLabel	= false;
//
//	DL Plus state initialization
	dlPlusNumTags	= 0;
	dlPlusItemToggle = false;
	dlPlusItemRunning = false;
	dlPlusValid	= false;
}

	padHandler::~padHandler	(void) {
	if (currentSlide != nullptr)
	   delete currentSlide;
}

//	Data is stored reverse, we pass the vector and the index of the
//	last element of the XPad data.
//	 L0 is the "top" byte of the L field, L1 the next to top one.
void	padHandler::processPAD (uint8_t *buffer,
	                        int16_t last,
	                        uint8_t L1,
	                        uint8_t L0) {
uint8_t	fpadType	= (L1 >> 6) & 03;

	if (fpadType != 00) 
	   return;
//
//	OK, we'll try

	uint8_t x_padInd = (L1 >> 4) & 03;
	uint8_t CI_flag  = L0 & 02;
	switch (x_padInd) {
	   default:
	      break;

	   case  01 :
	      handle_shortPAD (buffer, last, CI_flag);
	      break;

	   case  02:
	      handle_variablePAD	(buffer, last, CI_flag);
	      break;
	}
}
//
//	Since the data is stored in reversed order, we pass
//	on the vector address and the offset of the last element
//	in that vector
void	padHandler::handle_shortPAD (uint8_t *b, int16_t last, uint8_t CIf) {
//	The short X-PAD is four bytes in every audio frame. With a contents
//	indicator, the first names the application and three bytes of it follow;
//	without one, all four continue the application of the frame before.
//	The dynamic label travels this way on stations with little room for data:
//	its bytes go to the same collector as those of the variable X-PAD, where a
//	data group is used only if it arrives whole and its checksum holds.
uint8_t	data [4];
int16_t	i;

	if (CIf) {
	   uint8_t AcTy = b [last] & 037;	// application type
	   if ((AcTy == 2) || (AcTy == 3)) {	// dynamic label: start, continuation
	      for (i = 0; i < 3; i ++)
	         data [i] = b [last - 1 - i];
	      shortPadLabel	= true;
	      dynamicLabel (data, 3, AcTy);
	   }
	   else				// another application, or the end marker
	      shortPadLabel	= false;
	}
	else
	if (shortPadLabel) {
	   for (i = 0; i < 4; i ++)
	      data [i] = b [last - i];
	   dynamicLabel (data, 4, 3);
	}
}
///////////////////////////////////////////////////////////////////////
//
//	Here we end up when F_PAD type = 00 and X-PAD Ind = 02
static
int16_t	lengthTable [] = {4, 6, 8, 12, 16, 24, 32, 48};

//
//	Since the data is reversed, we pass on the vector address
//	and the offset of the last element in the vector,
//	i.e. we start (downwards)  beginning at b [last];
void	padHandler::handle_variablePAD (uint8_t *b,
	                                int16_t last, uint8_t CI_flag) {
int16_t	CI_Index = 0;
uint8_t CI_table [4];
int16_t	i, j;
int16_t	base	= last;	
std::vector<uint8_t> data;

//	If an xpadfield shows with a CI_flag == 0, and if we are
//	dealing with an msc field, the size to be taken is
//	the size of the latest xpadfield that had a CI_flag != 0
	if (CI_flag == 0) {
	   if (mscGroupElement && (xpadLength > 0)) {
	      data. resize (xpadLength);
	      for (j = 0; j < xpadLength; j ++)
	         data [j] = b [last - j];
	      add_MSC_element (data);
	   }
	   return;
	}
//
//	The CI flag in the F_PAD data is set, so we have local CI's
//	7.4.2.2: Contents indicators are one byte long

	while (((b [base] & 037) != 0) && (CI_Index < 4))
	   CI_table [CI_Index ++] = b [base --];

	if (CI_Index < 4) 	// we have a "0" indicator, adjust base
	   base -= 1;

//	The space for the CI's does belong to the Cpadfield, so
//	but do not forget to take into account the '0'field if CI_Index < 4
	if (mscGroupElement) {	
	   xpadLength = 0;
	   for (i = 0; i < CI_Index; i ++)
	      xpadLength += lengthTable [CI_table [i] >> 5];
	   xpadLength += CI_Index == 4 ? 4 : CI_Index + 1;
	}
//
//	Handle the contents
	for (i = 0; i < CI_Index; i ++) {
	   uint8_t appType	= CI_table [i] & 037;
	   int16_t length	= lengthTable [CI_table [i] >> 5];

	   if (appType == 1) {
	      dataGroupLength = ((b [base] & 077) << 8) | b [base - 1];
	      base -= 4;
	      last_appType = 1;
	      continue;
	   }

//	collect data, reverse the reversed bytes
	   data. resize (length);
	   for (j = 0; j < length; j ++)  
	      data [j] = b [base - j];

	   switch (appType) {
	      default:
	         return;	// sorry, we do not handle this

	      case 2:
	      case 3:
	         dynamicLabel ((uint8_t *)(data. data ()),
	                        data. size (), CI_table [i]);
	         break;

	      case 12:
	         new_MSC_element (data);
	         break;

 	      case 13:
	         add_MSC_element (data);
	         break;
	   }

	   last_appType = appType;
	   base -= length;
	   if (base < 0 && i < CI_Index - 1) {
	      fprintf (stderr, "Hier gaat het fout, base = %d\n", base);
	      return;
	   }
	}
}
//
//	Handle DL Plus command (ETSI TS 102 980)
//	Called when Cflag=1 in dynamic label segment
//	Parses DL Plus tags and stores them for later callback
void	padHandler::handleDLPlusCommand (uint8_t *data, int16_t length) {
//	The command field of a DL Plus command (ETSI TS 102 980, 7.4):
//	  byte 0: CId (4 bits; 0000 = the tags of the label), IT (item toggle),
//	          IR (item running), NT (2 bits: the number of tags, less one)
//	  then three bytes for each tag, each with a spare bit in front:
//	          content type (7 bits), start marker (7 bits), length marker (7 bits)
//	The markers count characters of the label; the length marker is the length less one.
	if (length < 1)
	   return;
	if ((data [0] >> 4) != 0)	// another command: not the tags
	   return;

	uint8_t numTags	= (data [0] & 0x03) + 1;
	if (length < 1 + 3 * numTags) {	// cut short: no tags rather than wrong ones
	   dlPlusValid = false;
	   return;
	}

	dlPlusItemToggle	= (data [0] >> 3) & 0x01;
	dlPlusItemRunning	= (data [0] >> 2) & 0x01;
	for (int t = 0; t < numTags; t ++) {
	   dlPlusTags [t]. contentType	= data [1 + 3 * t] & 0x7F;
	   dlPlusTags [t]. startMarker	= data [2 + 3 * t] & 0x7F;
	   dlPlusTags [t]. length	= data [3 + 3 * t] & 0x7F;
	}
	dlPlusNumTags	= numTags;
	dlPlusValid	= true;
}
//
//	A dynamic label is created from a sequence of (dynamic) xpad
//	fields, starting with CI = 2, continuing with CI = 3
//
//	The dynamic label (ETSI EN 300 401, 7.4.5.2). A label is sent as up to eight
//	segments, each in a data group of its own: two bytes of prefix, the characters,
//	and a checksum over both. A data group may arrive in several X-PAD subfields: a
//	first one (application type 2) and continuations (type 3).
//
//	A group is used only when it has arrived whole and its checksum holds, and a label
//	is shown only when every one of its segments is there. With a weak signal that
//	means a label arrives later or not at all; it never arrives with pieces missing
//	or with the pieces of two labels mixed.
void	padHandler::dynamicLabel (uint8_t *data, int16_t length, uint8_t CI) {
	if ((CI & 037) == 02)		// the first subfield of a data group
	   dlGroup. clear ();
	else
	if (dlGroup. empty ())		// a continuation of a group whose start was missed
	   return;

	if (length <= 0)
	   return;
	if (dlGroup. size () + length > 96) {	// no group is as long as that
	   dlGroup. clear ();
	   return;
	}
	dlGroup. insert (dlGroup. end (), data, data + length);
	if (dlGroup. size () < 2)
	   return;

//	The prefix says what the group is and how long
	bool	command		= (dlGroup [0] & 0x10) != 0;
	bool	removeLabel	= false;
	bool	plusCommand	= false;
	size_t	fieldLength	= 0;
	if (command) {
	   switch (dlGroup [0] & 0x0F) {
	      case 0x01:		// remove the label from the display
	         removeLabel	= true;
	         break;
	      case 0x02:		// DL Plus
	         plusCommand	= true;
	         fieldLength	= (dlGroup [1] & 0x0F) + 1;
	         break;
	      default:			// a command not known here
	         dlGroup. clear ();
	         return;
	   }
	}
	else
	   fieldLength	= (dlGroup [0] & 0x0F) + 1;

	size_t groupLength = 2 + fieldLength;
	if (dlGroup. size () < groupLength + 2)	// the checksum is not there yet
	   return;

	if (!check_crc_bytes (dlGroup. data (), groupLength)) {
	   dlGroup. clear ();		// damaged on the way: not used
	   return;
	}

	std::vector<uint8_t> group (dlGroup. begin (),
	                            dlGroup. begin () + groupLength);
	dlGroup. clear ();
	int16_t	toggle	= (group [0] & 0x80) ? 1 : 0;

	if (removeLabel) {
	   resetLabel (-1);
	   if (!dynamicLabelText. empty ()) {
	      dynamicLabelText. clear ();
	      if (dataOut != nullptr)
	         dataOut (dynamicLabelText. c_str (), ctx);
	   }
	   return;
	}

	if (plusCommand) {
//	   The tags belong to the label that carries the same toggle
	   handleDLPlusCommand (&group [2], (int16_t)fieldLength);
	   dlPlusToggle	= toggle;
	   if (dlComplete && dlToggle == toggle)
	      showLabel (true);
	   return;
	}

//	A segment of the text. Another toggle means another label
	if (toggle != dlToggle)
	   resetLabel (toggle);
	if (dlComplete)			// the label is known; this is its repetition
	   return;

	bool	first	= (group [0] & 0x40) != 0;
	bool	last	= (group [0] & 0x20) != 0;
	int16_t	segment	= first ? 0 : ((group [1] >> 4) & 0x07);
	if (first)
	   charSet	= (group [1] >> 4) & 0x0F;
	if (dlHave [segment])
	   return;
	dlSegments [segment]. assign (group. begin () + 2, group. end ());
	dlHave [segment]	= true;
	if (last)
	   dlLast	= segment;

	if (dlLast < 0)
	   return;
	for (int16_t i = 0; i <= dlLast; i ++)
	   if (!dlHave [i])
	      return;
	dlComplete	= true;
	showLabel (false);
}

//	Forget the label being collected; the next one carries the given toggle
void	padHandler::resetLabel (int16_t toggle) {
	for (int i = 0; i < 8; i ++) {
	   dlSegments [i]. clear ();
	   dlHave [i]	= false;
	}
	dlToggle	= toggle;
	dlLast		= -1;
	dlComplete	= false;
}

//	The label is complete: hand it on, and with it the tags that belong to it.
//	tagsOnly: the text was handed on before, the tags have arrived since.
void	padHandler::showLabel (bool tagsOnly) {
	if (!tagsOnly) {
	   std::vector<uint8_t> raw;
	   for (int16_t i = 0; i <= dlLast; i ++)
	      raw. insert (raw. end (), dlSegments [i]. begin (),
	                                dlSegments [i]. end ());
	   std::string text = toStringUsingCharset ((const char *)raw. data (),
	                                            (CharacterSet) charSet,
	                                            (int)raw. size ());
	   if (text == dynamicLabelText && !dlPlusValid)
	      return;			// the same label sent again
	   bool changed	= text != dynamicLabelText;
	   dynamicLabelText = text;
	   if (changed && dataOut != nullptr)
	      dataOut (dynamicLabelText. c_str (), ctx);
	}
	if (dlPlusValid && dlPlusToggle == dlToggle && dlPlusOut != nullptr)
	   dlPlusOut (dynamicLabelText. c_str (),
	              dlPlusNumTags,
	              dlPlusTags,
	              dlPlusItemToggle,
	              dlPlusItemRunning,
	              ctx);
}

//
//	Called at the start of the msc datagroupfield,
//	the msc_length was given by the preceding appType "1"
void	padHandler::new_MSC_element (std::vector<uint8_t> data) {

	if ((int)data. size () >= dataGroupLength) {
//	   msc element is single item
	   build_MSC_segment (data);
	   mscGroupElement = false;
//	   show_motHandling (true);
//         fprintf (stderr, "msc element is single\n");
	   return;
	}

	mscGroupElement		= true;
	msc_dataGroupBuffer. clear ();
	msc_dataGroupBuffer     = data;
//	show_motHandling (true);
}

//
void	padHandler::add_MSC_element	(std::vector<uint8_t> data) {
int32_t currentLength = msc_dataGroupBuffer. size ();
//
//      just to ensure that, when a "12" appType is missing, the
//      data of "13" appType elements is not endlessly collected.
	if (currentLength == 0) {
	   return;
	}

	msc_dataGroupBuffer. insert (std::end (msc_dataGroupBuffer),
	                             std::begin (data), std::end (data));
	if ((int)(msc_dataGroupBuffer. size ()) >= dataGroupLength) {
	   build_MSC_segment (msc_dataGroupBuffer);
	   msc_dataGroupBuffer. clear ();
	   mscGroupElement      = false;
//	   show_motHandling (false);
	}
}

void	padHandler::build_MSC_segment (std::vector<uint8_t> data) {
//	we have a MOT segment, let us look what is in it
//	according to DAB 300 401 (page 37) the header (MSC data group)
//	is
int32_t size    = (int)(data. size ()) <
	                 dataGroupLength ? data. size () :
                                                    dataGroupLength;
	if (size <= 2)
	   return;
	uint8_t		groupType	=  data [0] & 0xF;
	uint8_t		continuityIndex = (data [1] & 0xF) >> 4;
	uint8_t		repetitionIndex =  data [1] & 0xF;
	int16_t		segmentNumber	= -1;		// default
	uint16_t	transportId	= 0;		// default
	bool		lastFlag	= false;	// default
	uint16_t	index;

	(void)continuityIndex; (void)repetitionIndex;
	if ((data [0] & 0x40) != 0) {
	   bool res	= check_crc_bytes (data. data (), size - 2);
	   if (!res) {
//	      fprintf (stderr, "crc failed ");
	      return;
	   }
//	   else
//	      fprintf (stderr, "crc success ");
	}

	if ((groupType != 3) && (groupType != 4))
	   return;		// do not know yet

//	extensionflag
	bool	extensionFlag	= (data [0] & 0x80) != 0;
//	if the segmentflag is on, then a lastflag and segmentnumber are
//	available, i.e. 2 bytes more
	index			= extensionFlag ? 4 : 2;
	bool	segmentFlag	=  (data [0] & 0x20) != 0;
	if ((segmentFlag) != 0) {
	   lastFlag		= data [index] & 0x80;
	   segmentNumber	= ((data [index] & 0x7F) << 8) | data [index + 1];
	   index += 2;
	}

//	if the user access flag is on there is a user accessfield
	if ((data [0] & 0x10) != 0) {
	   int16_t lengthIndicator = data [index] & 0x0F;
	   if ((data [index] & 0x10) != 0) { //transportid flag
	      transportId = data [index + 1] << 8 |
	                    data [index + 2];
	      index += 3;
	   }
	   else {
//	      fprintf (stderr, "sorry no transportId\n");
	      return;
	   }
	   index += (lengthIndicator - 2);
	}

	uint32_t segmentSize    = ((data [index + 0] & 0x1F) << 8) |
	                            data [index + 1];
//
//      handling MOT in the PAD, we only deal here with type 3/4
	switch (groupType) {
	   case 3:
	      if (currentSlide == nullptr) {
//	         fprintf (stderr, "creating %d\n", (uint32_t)transportId);
	         currentSlide   = new motObject (motdata_Handler,
	                                         false,
	                                         transportId,
	                                         &data [index + 2],
	                                         segmentSize,
	                                         lastFlag,
	                                         ctx);
	      }
	     else {
	         if (currentSlide -> get_transportId () == transportId)
	            break;
//	         fprintf (stderr, "out goes %u, in comes %u\n",
//	                  currentSlide -> get_transportId (),
//	                  (uint32_t)transportId);
	         delete currentSlide;
	         currentSlide   = new motObject (motdata_Handler,
	                                         false,
	                                         transportId,
	                                         &data [index + 2],
	                                         segmentSize,
	                                         lastFlag,
	                                         ctx);
	      }
	      break;
	  case 4:
	      if (currentSlide == nullptr)
	         return;
	      if (currentSlide -> get_transportId () == transportId) {
//               fprintf (stderr, "add segment %d of  %d\n",
//                                 segmentNumber, transportId);
	         currentSlide -> addBodySegment (&data [index + 2],
	                                         segmentNumber,
	                                         segmentSize,
	                                         lastFlag);
	      }
	      break;

	   default:             // cannot happen
	      break;
	}
}


